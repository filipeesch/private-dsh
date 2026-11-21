# Agent Note: Process shutdown is one idempotent, durable-first sequence

Status: implemented

English | [中文](2026-11-21-graceful-process-shutdown.zh.md)

## Problem

One terminal interrupt reaches a long-lived application more than once. The terminal signals the foreground process group, and a package-manager wrapper re-sends the same signal to its child, so a single Ctrl-C delivered two `SIGINT` events to the application within the same millisecond. The controller treated any signal received while a shutdown was already running as impatience and called `process.exit` immediately, which cut the generic teardown in the middle: pending Session appends were never flushed, storage claims were not released in order, and children running in their own session - program environments, background jobs, persistent terminals, external tool processes - were orphaned. The same rule made an interrupt's exit code race a supervisor's later termination request.

## Decision

Signals request one shutdown; they never escalate it. The first request fixes the exit code, later signals join it, and elapsed time is the only thing that can force an exit.

The shutdown runs ordered phases, and the phases belong to the launcher because it owns the signal handlers and the root context:

1. quiesce: cancel running turns and wait for their settlement, so cancellation outcomes are recorded before anything is flushed;
2. barrier: flush every open Session write handle, the durability call the persistence service already exposes;
3. teardown: dispose the tree, which closes handles, releases claims, and terminates owned children.

The barrier gets its own budget carved out of the deadline rather than racing it: when quiesce consumes the whole deadline, the barrier still runs before the forced exit. The deadline is a fixed ten seconds, and the development supervisor's escalation grace is raised above it so the supervisor cannot convert the interrupt into a second signal while the application is still inside its own deadline. When the deadline expires, the launcher writes one report to standard error naming the unfinished phases, and says separately when the barrier itself did not finish in its reserve. The fatal-error handler joins the same sequence instead of disposing the tree alone.

## Alternatives considered

**Force on any second signal.** The shipped behavior, and the defect: one terminal interrupt is two signals, so the graceful path was never reachable through `make`/`pnpm`.

**Force only when the second signal differs from the first.** A supervisor that re-sends a termination request after the interrupt still cuts the teardown.

**Leave escalation to each caller's timeout.** No surface has one, and the signals are already delivered.

**A configurable deadline.** Considered and rejected for this change; a fixed bound with a pending report is enough to diagnose a slow teardown, and the supervisor grace is the only value coupled to it.

**Rely on disposal order instead of an explicit barrier.** Application-tree disposal cannot promise that durable state is flushed before a forced exit, and it produces no report of what remained pending.

## Consequences

An interrupt always runs the same sequence, so a Session log is readable after the process exits even when the deadline expires. A slow phase is diagnosable from one stderr line instead of a silent truncation. The deadline is fixed, so a machine that needs longer leans on the report rather than a configuration knob. `dev-web` stops six seconds after the first signal only if the application exits first; its grace is now above the application's deadline, and the two values must move together.
