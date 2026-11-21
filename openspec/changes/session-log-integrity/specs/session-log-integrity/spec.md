# Spec Delta

## Purpose

Keep the durable Session log readable and unambiguous when a provider reuses one tool-call id across model steps, and give operators a supported way to recover logs that already contain colliding PTC dispatch ids.

## ADDED Requirements

### Requirement: PTC sub-call identity is unique within a Session log

Every started PTC sub-call MUST record a sub-call id that is unique within that Session log, independently of how many times the provider reuses the enclosing tool-call id, and the start and settlement records of one sub-call MUST carry the same id.

#### Scenario: The provider reuses one tool-call id in consecutive steps

- **WHEN** two consecutive model steps each dispatch a program that calls at least one nested tool, and the provider advertises the same tool-call id for both program calls
- **THEN** every recorded sub-call id in the log is distinct, and reading the complete log succeeds

#### Scenario: One program dispatches several nested tools

- **WHEN** a single program dispatches three nested tools in submission order
- **THEN** the log records three distinct sub-call ids, each appearing once as a start and once as a settlement

#### Scenario: A program dispatches a program that dispatches tools

- **WHEN** a nested program call runs inside another program
- **THEN** the inner sub-call ids remain distinct from the enclosing sub-call id and from each other, and reading the log succeeds

### Requirement: Recorded sub-call ids are preserved as written

Reading a Session log MUST return sub-call ids exactly as recorded, including ids written by earlier releases in the legacy `<parent>:ptc:<n>` shape, and migrations MUST NOT rewrite them.

#### Scenario: A log recorded before this change is opened

- **WHEN** a Session log whose sub-call ids use the legacy shape is opened and read
- **THEN** every recorded id is returned unchanged, and each start pairs with its settlement by exact id equality

#### Scenario: A dispatch outside any model step

- **WHEN** a program call runs where no model step owns the invocation
- **THEN** its sub-call ids are still recorded, and the log remains readable

### Requirement: A repeated sub-call start remains a format error

The Session format reader MUST continue to reject a log whose `tool/ptc-dispatch-start` records repeat a sub-call id, reporting the error it reports today, and rejection MUST NOT modify the stored log.

#### Scenario: A colliding log is opened

- **WHEN** a stored log contains two starts with the same sub-call id
- **THEN** opening the Session fails with the existing format error, and the stored bytes are unchanged

### Requirement: Supported repair of colliding PTC dispatch ids

A supported command MUST be able to repair a stored Session log whose PTC dispatch ids collide, by renumbering only the ids of the later colliding invocation, without changing any other recorded value.

#### Scenario: Dry run reports and writes nothing

- **WHEN** the command runs against a colliding log without the write confirmation
- **THEN** it reports each planned id change and leaves every file byte-identical

#### Scenario: Repairing a colliding log

- **WHEN** the command runs against a colliding log with the write confirmation
- **THEN** it writes a backup of the original, replaces only the colliding ids, keeps every other value and the record order unchanged, keeps the stored encoding valid, and verifies that no start id repeats afterwards

#### Scenario: Root tool-call ids are never renumbered

- **WHEN** the colliding invocation's program call id is itself repeated across steps
- **THEN** the repair leaves program call ids untouched and renumbers only nested sub-call ids

#### Scenario: A log without collisions is reported and left alone

- **WHEN** the command runs against a log whose sub-call ids are already unique
- **THEN** it reports that no repair is needed and writes nothing

#### Scenario: A damaged tail is refused

- **WHEN** the stored log ends in an incomplete record or an incomplete compressed frame
- **THEN** the command refuses that Session with a diagnostic naming the reason and leaves the file unchanged

#### Scenario: One unreadable Session does not stop the run

- **WHEN** the command processes a Session root containing several Sessions and one of them fails
- **THEN** the remaining Sessions are still processed and the summary reports the failure separately
