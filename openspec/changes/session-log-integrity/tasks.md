# Tasks

## 1. Step coordinates on the tool invocation

- [x] 1.1 Add the optional model-step coordinates to the tool invocation contract, documenting that the loop owns the value and that it is not model-facing; verify with `pnpm run typecheck` and the tool package tests.
- [x] 1.2 Populate the coordinates from the batch that already records `tool/call`, keeping one source of truth for the step; verify the existing tool pipeline and batch tests still pass.
- [x] 1.3 Update the tool subsystem documentation and any generated type surface that reproduces the invocation contract; verify with `pnpm run doc-sync` and the type-equivalence gate.

## 2. PTC sub-call identity

- [x] 2.1 Extract one helper that derives a sub-call id, and separate the dispatch-attempt counter from the identity it currently doubles as; verify the PTC package unit tests pass.
- [x] 2.2 Derive the id from `<callId>:ptc:<turn>:<step>:<n>` when coordinates exist and keep the legacy shape otherwise; verify unit tests for both shapes.
- [x] 2.3 Propagate the coordinates into the executions created for nested program dispatches; verify a program-inside-a-program test keeps every inner id distinct.
- [x] 2.4 Add the regression test with one provider tool-call id reused across consecutive steps: assert distinct start ids and that the produced log is accepted by the real V4 reader.
- [x] 2.5 Update the PTC package README, the dispatch payload JSDoc, the runtime type JSDoc, and the PTC Agent Note to describe the new id convention while keeping ids documented as opaque; verify with `pnpm run doc-sync`.

## 3. Offline repair command

- [x] 3.1 Add the root script and its `package.json` entry, with a Session-root argument, dry-run default, report location, and `--help`; verify the help text and a dry run over a fixture root.
- [x] 3.2 Implement physical frame scanning, row decoding, program-call window detection, and collision-renumbering that never touches a program call id; verify with unit tests for colliding, clean, and root-id-repeated logs.
- [x] 3.3 Implement the write path: backup before replacement, recompression limited to affected frames, and self-verification of row count, intended-only differences, frame boundaries, and absence of repeated starts; verify a repaired fixture opens with the real reader and differs only in renumbered ids.
- [x] 3.4 Implement refusals and per-Session isolation: incomplete tail, storage claim held by a live process, and one failing Session not stopping the rest; verify each case with a test and the summary output.
- [x] 3.5 Document the command next to the existing offline Session migration, including what it changes, the backup location, and when it refuses; verify with `pnpm run doc-sync`.

## 4. Graceful shutdown controller

- [x] 4.1 Rework the shutdown controller so repeated signals join one request, the exit code comes from the first request, and forcing happens only when the deadline expires; verify with controller unit tests covering a duplicated interrupt and a mixed `SIGTERM`/`SIGINT` pair.
- [x] 4.2 Replace the behaviour and tests that assert a second signal forces immediate exit; verify the controller and CLI tests pass with the new contract.
- [x] 4.3 Implement the phased runner: quiesce, durability barrier, release, owned children, exit; give the barrier its own budget carved out of the deadline; verify with unit tests using fakes for each phase.
- [x] 4.4 Write the pending report naming unfinished phases or resources when the deadline expires; verify with a test that asserts the report and the exit code.
- [x] 4.5 Move the fixed deadline to ten seconds with its rationale documented, and confirm the forced path still runs the barrier; verify with a test that expires the deadline during quiesce.
- [x] 4.6 Verify the fatal-error handler cannot preempt a shutdown already in progress; add or adjust the test that proves it.
- [x] 4.7 Raise the development supervisor's escalation grace above the application deadline; verify with the supervisor test and a comment stating the relationship.

## 5. Durability and children against real seams

- [x] 5.1 Quiesce real work before the barrier: stop intake and abort running turns, awaiting their settlement so cancellation outcomes are recorded; verify with a real-composition test that the cancellation result is present in the stored log.
- [x] 5.2 Run the durability barrier against the persistence flush and release storage claims before teardown completes; verify with a test that the claim is released and every accepted event is readable after exit.
- [x] 5.3 Terminate owned children that cannot receive the terminal's signal - program environments, background jobs, persistent terminals, and external tool processes - with a termination request then a forceful kill; verify a test with a child that ignores the first request.

## 6. Real-composition and integration verification

- [x] 6.1 Boot the Web profile through the Loader, deliver the same interrupt twice as the terminal does, and assert the interrupt exit code and that no owned child survives; verify by running that test. The readable-log half of this scenario is proved against the real persistence seam by 5.2 rather than through a Web client, because a client is what opens a Session and driving one is outside this test's scope.
- [x] 6.2 Assert the termination-signal path exits successfully and flushes, and that an idle interrupt does not wait for the whole deadline; verify by running those tests.
- [x] 6.3 Exercise the deadline-expiry path and assert the pending report, the barrier still running, and the forced exit code; verify by running that controller test. The readable-log half is proved by the barrier test in 5.2.

## 7. Fixtures, snapshots, and gates

- [x] 7.1 Refresh recorded sessions that carry writer-produced dispatch ids, review every diff, and confirm only dispatch ids changed; verify with the keyless snapshot suites and the record/refresh policy in `snapshots/AGENTS.md`.
- [x] 7.2 Update the TypeScript SDK expectations (done, keyless refresh) and confirm the Python SDK lane needs no fixture change: its client tests build synthetic JSON-RPC events and its single-executable fixtures are replayed inputs, so no writer-produced id appears there; verify with the SDK snapshot suites.
- [x] 7.3 Run the affected gates and record the commands and results: `pnpm run typecheck` (5 gates), `pnpm run build:check` (2 gates), `pnpm run doc-sync` (42 gates), `pnpm run lint` (0 errors), `pnpm run duplication` (0 clones), `pnpm run verify-persistence-changes` (66 roots match 25 records), `pnpm run verify-type-equiv`, `pnpm run verify-translation-pairing`, `pnpm run verify-no-unknown-casts`, `pnpm run verify-package-dependencies`, `pnpm run verify-runtime-closure` — all pass; targeted suites `packages/core/tools`, `packages/core/tool-executor-ptc`, `apps/cli`, `scripts/repair-session-ptc-dispatch.spec.ts`, `scripts/dev-web.spec.ts` (685 tests) and `pnpm run test:snapshot` (253 tests) all pass.

## 8. Decision records

- [x] 8.1 Write the Agent Note for the shutdown ordering decision - single request, durability barrier, phases, fixed deadline, pending report - with the alternatives this design rejected; verify `pnpm run verify-agent-note-format`.
- [x] 8.2 Confirm no persistence-change record is required: `pnpm run verify-persistence-changes` reports 66 roots matching 25 history records, because the id text and shutdown behavior change no declared persistence type; state the result in the pull request.