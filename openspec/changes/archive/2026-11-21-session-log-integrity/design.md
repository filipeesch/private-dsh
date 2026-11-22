# Design

## Context

See `proposal.md` - Why for motivation.

Two mechanisms shape both deltas.

The PTC executor mints one sub-call id per nested dispatch inside a program, from a counter that belongs to that program run. The id is opaque to every consumer: clients, exports, job records, and spill references correlate by exact equality, and migrations preserve recorded ids byte for byte. The Session format reader keeps one dispatch map for the whole artifact and rejects a repeated start with `SessionFormatError: PTC dispatch repeats subCallId`; that rejection is part of released V4 behavior.

The launcher installs the process signal handlers before the profile boots, so teardown owns the entire startup window. Today the first signal starts a graceful dispose bounded by a fixed 5s deadline, and any later signal forces `process.exit` immediately. Session durability is a separate explicit operation: the persistence service exposes a flush that drains routed appends and flushes each open write handle, and each handle's close drains before returning.

Constraints from the repository that shape the decision: recorded V4 logs keep their meaning and their bytes; the reader's requirement set does not change; no new global or module-level shared state; opaque identifiers stay opaque; a writer change that only alters the text of an opaque id changes no persisted type, so no persistence-change record and no format version bump apply.

Measured behavior that motivates the shutdown decisions: `make web` runs `pnpm run start:web`, which starts the app as a child of a shell wrapper. One Ctrl-C in a terminal delivers the interrupt to the foreground process group and `pnpm` re-sends the same signal to its child, so the application's handler runs twice within the same millisecond. In that chain the wrapper and `pnpm` survive until the application exits, so anything that delays the application looks like a hung shutdown.

## Goals / Non-Goals

**Goals:**

- Make sub-call uniqueness a property of the log that is true by construction, without new shared state and without changing what consumers may assume about ids.
- Make an interrupt finish durable work before the process exits, and make the worst case - an expired deadline - still leave a readable log.
- Keep every teardown phase observable enough to name what remained pending at the deadline.

**Non-Goals:**

- Changing reader acceptance, the format version, or released bytes.
- Pruning the reader's settled dispatch entries; the format packages have their own review, so that stays a separate change.
- Unifying the signal handling of `dev-web`, `dev-bundle-registry`, and the mock server behind one helper; only the application deadline and the `dev-web` grace move here.
- Making the shutdown deadline configurable.

## Decisions

### Sub-call ids carry the owning model step, and nested ids use a disjoint shape

New root sub-call ids become `<callId>:ptc-2026-11:<turn>:<step>:<n>`; nested dispatches use `<parentSubCallId>+<n>`, because a provider may advertise a root id that is textually equal to a minted sub-call id (`x` and `x:ptc:1:1:1` in one step). With one formula, the nested child of `x` and the first child of the root `x:ptc:1:1:1` would both be `x:ptc:1:1:1:ptc:1:1:1`. Two disjoint shapes remove that alias: a root id always ends with `:ptc-2026-11:<turn>:<step>:<n>`, a nested id always ends with `+<n>`, and two nested ids can only coincide when their parents and ordinals do.

The invariant that makes this unique: the reader requires every advertised tool-call id to be distinct within its assistant message, and one message belongs to exactly one step. So one tool-call id can only recur in a different step, and `(turn, step)` distinguishes the two invocations. `n` still counts dispatch attempts inside one program, including attempts rejected before dispatch.

Alternatives considered and rejected:

- A counter keyed by the root call id inside the executor: the counter lives in the process, so resuming a Session in a new process restarts it and reintroduces the collision.
- Reading the current step's `step/start` sequence from the agent's turn-boundary projection: also sound, but it makes the executor depend on the agents service and on one projection's internals for an identity it can receive directly.
- Rewriting provider tool-call ids to be unique per Session: the id round-trips to the provider with its tool result, so rewriting it would break that correlation.
- Accepting repeats in the reader: rejected for this change; the reader stays fail-closed.

When no model step owns the invocation, the id keeps the legacy `<callId>:ptc-2026-11:<n>` shape. Those invocations write no `tool/call` record, and a dispatch outside an open turn is already rejected on read, so no reachable case collides.

### The step coordinates travel with the invocation

The tool invocation contract gains an optional `log` field carrying `turn` and `step`. The batch already receives exactly this value to record `tool/call` and includes it on each execution it schedules, so the invocation becomes the single carrier and the batch stops being the only reader.

Alternatives considered and rejected: a new public Agent accessor (widens the agent surface for one consumer); putting coordinates on the resolved tool set (the registry owns admission, not loop position); a PTC-internal side channel (creates a second source of truth for the same fact).

### Nested dispatches inherit the coordinates

The PTC executor copies the invocation's coordinates into the executions it creates for nested dispatches, so a program dispatched by a program still gets unique ids at every level. The fallback shape applies only when the invocation has no coordinates.

### Historical ids stay untouched

Reading returns recorded ids as written, including `:code:` and legacy `:ptc:` shapes, and the sub-call id shape is documented only as a writer-side convention.

### Reader acceptance does not change

A log with a repeated start remains unreadable until it is repaired. The trade-off is explicit: the writer fix stops new occurrences, and the repair command is the supported path for logs already on disk. No format version bump, no persistence-change record, and no reader-compatibility review are needed because neither the schema nor the reader's requirement set changes.

### Repair is an offline command that preserves everything except colliding ids

A root script follows the shape of the existing offline Session migration: it takes a Session root, defaults to a dry run, processes Sessions independently, keeps a summary, and writes its report to a private temporary location.

The repair itself: walk the physical frames, decode rows, locate the tool-call windows that repeat a program call id, and renumber only the nested sub-call ids of a later window that collide with an id already used earlier in the log. Then rewrite only the rows that changed, recompress only the frames that contain them, and verify the result: identical row count, differences limited to intended renames, valid frame boundaries, and no repeated start id. The original file is copied to the backup directory before replacement, and the command refuses to touch a Session whose storage claim is held by a live process or whose tail is incomplete.

Alternatives considered and rejected: repairing in memory at read time (hides the ambiguity from every consumer without fixing the artifact); a successor format generation that normalizes ids (cannot reuse the accepted 3->4 transition, and would rewrite released records).

### Signals are requests, and repeats are the same request

The shutdown controller treats the first signal as a request and every later signal as the same request; it forces exit only when the deadline expires. Escalation cannot be derived from the signal count, because one terminal interrupt legitimately arrives twice. The exit code comes from the first request, so a later `SIGTERM` from a supervisor cannot turn an interrupt into a success exit.

Alternatives considered and rejected: forcing only when the second signal differs from the first (a supervisor that re-sends `SIGTERM` would still cut teardown); leaving escalation to the caller's own timeout (no surface has one).

### Shutdown is phased, and the durability barrier has its own budget

The launcher owns the phases because it owns the root context and the handlers:

1. quiesce: stop intake and abort running work, then let it settle so its cancellation outcome is recorded;
2. barrier: flush every open Session write handle through the durability call the persistence service already exposes;
3. release: close handles and release storage claims;
4. children: terminate owned children with a termination request, then a forceful kill;
5. exit with the first request's code.

The barrier is carved out of the deadline rather than raced against it: when quiesce consumes the whole deadline, the barrier still runs with its own budget before exit. This is what makes an expired deadline survivable, and it is the only ordering guarantee that matters when everything else times out.

Alternatives considered and rejected: relying on disposal order inside the application tree (cannot guarantee flush-before-exit and produces no pending report); a separate watchdog process (a whole new process to own for one deadline).

### The deadline is a fixed ten seconds

The constant moves from five to ten seconds and stays a fixed bound with its rationale documented next to it. The `dev-web` supervisor grace rises above it so the supervisor never escalates while the application is still inside its own deadline.

### The pending report goes to standard error

When the deadline expires, the launcher writes one report naming the phases and resources that had not finished. Standard error is the only surface available before the application tree exists and the only one shared by headless, Web, and Desktop.

## Risks / Trade-offs

- [Recorded fixtures contain writer-produced ids in the legacy shape] -> Refresh recorded sessions keylessly, review every diff, and confirm that only dispatch ids changed before committing.
- [Widening the invocation contract reaches every tool] -> The field is optional, never part of model-facing output, and never logged as part of tool arguments; existing tools are unaffected by construction.
- [A forced exit can still lose events appended after the barrier] -> The barrier runs after quiesce, so no writer is left appending; the shutdown tests assert a readable log at the deadline.
- [Ten seconds may still be too short on a busy machine] -> The log is already durable at that point; the pending report names what was cut, so the failure is diagnosable instead of silent.
- [The repair command writes released Session data] -> Dry run by default, backup before replacement, self-verification, refusal on a held claim or an incomplete tail, and per-Session isolation so one failure cannot damage another.
- [A writer change alters transcript fixtures] -> The refresh path is keyless replay; if a fixture cannot be refreshed, re-record only that scenario rather than hand-editing ids.

## Migration Plan

No stored-format migration. New records use the new id shape from the first release that contains the change, and older readers accept them because the id stays an opaque string.

Existing colliding logs are repaired on demand with the new command; nothing repairs automatically, and the reader keeps refusing unrepaired logs.

Rollback is a revert: older logs stay readable, new ids stay opaque to the reverted reader, and no bytes are rewritten by reading.

## Open Questions

- Whether `make web` should route through the same supervisor as `make dev-web` instead of having two stop policies. Deferred: the deadline and grace fix covers the reported failure, and unifying the two launch paths is a separate change.