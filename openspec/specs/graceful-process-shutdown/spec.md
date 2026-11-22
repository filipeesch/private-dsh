# graceful-process-shutdown Specification

## Purpose

Make a signal-driven shutdown of a long-lived application process finish its durable work before it exits, so interrupting the process never leaves a truncated Session log, a held storage claim, or an orphaned child process.

## Requirements

### Requirement: Repeated signals form one shutdown request

A signal received while a graceful shutdown is already in progress MUST join that shutdown instead of forcing process exit. Forced exit is permitted only after the shutdown deadline has expired, and the process MUST exit with the code of the first signal that requested the shutdown.

#### Scenario: One terminal interrupt delivers the signal twice

- **WHEN** the application receives the same interrupt signal twice within the same shutdown request, as a terminal delivers it through a process chain
- **THEN** the shutdown runs once to completion and the process exits with the interrupt code after its durable work is finished

#### Scenario: Two different termination signals arrive

- **WHEN** a termination request and an interrupt request arrive during the same shutdown
- **THEN** the process runs one shutdown and exits with the code of the first signal received

#### Scenario: A signal arrives after the deadline

- **WHEN** the shutdown deadline has already expired
- **THEN** the process may exit immediately, with the code of the first signal, and reports what remained pending

### Requirement: Durable work completes before exit

Before the process exits, whether the shutdown finished normally or its deadline expired, it MUST flush every open Session write handle and release its storage claims, so every event it accepted is durable and no claim outlives the process.

#### Scenario: Interrupt arrives while a Session is being written

- **WHEN** the interrupt signal arrives while events are still being appended to a Session log
- **THEN** those events are flushed before exit and reopening the Session succeeds and returns them

#### Scenario: Deadline expires during teardown

- **WHEN** teardown work exceeds the shutdown deadline
- **THEN** the process still performs the flush with its own budget before exiting, and the stored log remains readable with a complete final record

### Requirement: Shutdown runs in a fixed order

A shutdown MUST cancel work in flight, await its settlement, flush durable state, release storage claims, terminate owned children, dispose the profile's input surfaces, and only then exit. Work that an input surface accepts before its disposal may still start a turn; the shutdown does not claim a hard admission freeze.

#### Scenario: Interrupt arrives during a model turn

- **WHEN** the interrupt signal arrives while a turn is running
- **THEN** the turn's cancellation outcome is recorded, the Session log is flushed afterwards, and the process exits with the interrupt code

#### Scenario: Interrupt arrives while idle

- **WHEN** the interrupt signal arrives with no work in flight
- **THEN** the same order still applies, and the process exits without waiting for the full deadline

### Requirement: Owned child processes never outlive the application

A process that the application started and that does not receive the terminal's signal MUST be terminated by the application during shutdown, first with a termination request and then with a forceful kill when the grace expires, within the shutdown deadline.

#### Scenario: A program environment is running

- **WHEN** the interrupt signal arrives while a program environment process is executing
- **THEN** no child process from that environment survives after the application exits

#### Scenario: A child ignores the termination request

- **WHEN** an owned child does not exit within its grace period
- **THEN** the application forcefully kills it before exiting, and no child survives

### Requirement: The shutdown deadline is bounded and reported

The shutdown MUST be bounded by a fixed deadline of ten seconds from the first signal. When the deadline expires before teardown finishes, the process MUST report to standard error which shutdown phases or resources remained pending, and then exit.

#### Scenario: Teardown completes inside the deadline

- **WHEN** every phase of the shutdown completes before the deadline
- **THEN** no forced exit occurs and no pending report is written

#### Scenario: Teardown exceeds the deadline

- **WHEN** a phase or resource is still running when the deadline expires
- **THEN** the process writes a report naming the pending phases or resources and exits with the code of the first signal

### Requirement: A supervising development loop waits longer than the application

A development supervisor that stops the application MUST allow more time than the application's shutdown deadline before escalating, so a terminal interrupt is never converted into a forceful second signal while the application is still finishing durable work.

#### Scenario: Interrupting the development loop

- **WHEN** the development loop receives the terminal interrupt while the application is shutting down
- **THEN** it waits past the application deadline before escalating, and the application exits on its own with its durable work complete
