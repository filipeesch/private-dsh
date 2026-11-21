# Proposal

## Why

The Session log is the durable source of truth for a Session, and two shipped defects corrupt it. First, PTC sub-call ids repeat whenever the provider reuses one tool-call id across consecutive steps, so the V4 reader rejects the entire log with `SessionFormatError: PTC dispatch repeats subCallId`; twelve sessions were already repaired by hand and new cases kept appearing. Second, one Ctrl-C delivers two SIGINTs through the `make`/`pnpm` chain, and the second one forces `process.exit` in the middle of teardown, which cuts pending log appends, skips lease release, and orphans child processes.

## What Changes

- Derive each PTC sub-call id from the enclosing model step, so identity is unique by construction instead of depending on provider behaviour: `<callId>:ptc:<turn>:<step>:<n>`.
- Carry the owning step coordinates on the tool invocation so the PTC executor receives them, and propagate them into nested `run_code` dispatches.
- Add a supported offline repair command for logs that already contain colliding dispatch ids: it renumbers only the colliding dispatch ids, recompresses only the affected frames, defaults to a dry run, writes a backup, and self-verifies the result.
- Make signal handling idempotent: repeated signals join the shutdown already in progress, and forcing happens only when the shutdown deadline expires.
- Order every shutdown: quiesce (stop intake, abort turns, await settlement), durability barrier (flush every open Session handle), release handles and leases, terminate owned children (SIGTERM then SIGKILL), exit with the first signal's code.
- Run the durability barrier on the forced path as well, so an expired deadline still leaves a readable log.
- Raise the fixed shutdown deadline from 5s to 10s, and raise the `dev-web` supervisor's escalation grace above it so the supervisor never escalates before the app's own deadline.
- Report to stderr which phases or resources were still pending when the deadline expired.
- Non-goals: the V4 reader stays fail-closed and its requirements do not change; no Session format version bump; provider tool-call ids stay untouched.

## Capabilities

### New Capabilities

- `session-log-integrity`: unique PTC sub-call identity in the durable Session log, and a supported repair path for logs that already contain colliding dispatch ids.
- `graceful-process-shutdown`: signal-driven shutdown that is idempotent, durable-first, ordered, bounded, and reports unfinished teardown.

### Modified Capabilities

None. No existing capability covers Session log persistence or process shutdown.

## Impact

- `packages/core/tools`: the tool invocation contract gains optional model-step coordinates; the batch that logs `tool/call` already owns them.
- `packages/core/tool-executor-ptc`: sub-call id derivation, nested dispatch propagation, and the package README, event-payload JSDoc, and PTC Agent Note that document the id shape.
- `apps/cli`: the process shutdown controller and the signal wiring in profile boot.
- `scripts/dev-web.ts`: supervisor escalation grace, which must exceed the app's shutdown deadline.
- New offline repair script plus a root `package.json` script, following the `migrate:sessions-to-v4` command shape.
- Tests and fixtures: PTC unit coverage, shutdown controller coverage, a real-composition web shutdown test, and the recorded-session fixtures whose ids are produced by the writer.
- No persisted type change, so no persistence-change record; no Session format version change.
