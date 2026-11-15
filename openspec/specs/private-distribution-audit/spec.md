# private-distribution-audit Specification

## Purpose
Keeps the private distribution's invariant checkable in code: nothing leaves the application except the model, search, and plugin requests a user configures, and a synchronization cannot silently reintroduce a removed outbound path.

## Requirements

### Requirement: A removed package cannot come back

A package this distribution removes SHALL NOT be mounted again, declared as a dependency, or imported by shipped code. The audit SHALL report every such occurrence with the rule, the repository-relative path, and the removed package it names.

#### Scenario: Composition mounts a removed plugin

- **WHEN** a shipped composition file mounts a plugin from a removed package
- **THEN** the audit reports the file and the removed package, and fails

#### Scenario: A manifest depends on a removed package

- **WHEN** a shipped package manifest declares a dependency on a removed package
- **THEN** the audit reports the manifest and the removed package, and fails

#### Scenario: Shipped code imports a removed package

- **WHEN** shipped code imports a module from a removed package
- **THEN** the audit reports the importing file and the removed package, and fails

#### Scenario: Reading persisted events from a removed producer is not a reintroduction

- **WHEN** a session reader or migration module handles an event that a removed producer wrote
- **THEN** the audit reports nothing for it

### Requirement: A removed identifier cannot return outside compatibility paths

An identifier retired by this distribution SHALL NOT appear in shipped code, except in session reader and migration paths that must keep old Sessions loadable and in test fixtures. The audit SHALL report every occurrence outside those paths.

#### Scenario: Shipped code uses a retired identifier

- **WHEN** shipped code outside the compatibility paths names a retired identifier
- **THEN** the audit reports the path and the identifier, and fails

#### Scenario: A compatibility path names a retired identifier

- **WHEN** a session reader or migration module names a retired identifier so an older Session stays loadable
- **THEN** the audit reports nothing for it

#### Scenario: A test fixture names a retired identifier

- **WHEN** a test file outside the audited corpus names a retired identifier
- **THEN** the audit reports nothing for it, because tests are outside the corpus

### Requirement: Network egress is confined to declared transport seams

Network egress SHALL originate only in packages this distribution declares as transport seams. A package that is not declared SHALL NOT open a socket, resolve a host, or issue a fetch. Inside a declared seam, a literal host SHALL be one the policy records.

#### Scenario: An undeclared package starts egress

- **WHEN** a package outside the declared transport seams opens a socket, resolves a host, or issues a fetch
- **THEN** the audit reports the package and the call site, and fails

#### Scenario: A declared seam reaches a new literal host

- **WHEN** a declared transport seam names a literal host the policy does not record
- **THEN** the audit reports the file and the host, and fails

#### Scenario: A declared seam uses a user-configured endpoint

- **WHEN** a declared transport seam builds its endpoint from configuration rather than a literal
- **THEN** the audit reports nothing for it

#### Scenario: A protocol namespace is not egress

- **WHEN** shipped code contains a namespace URI that identifies a document format rather than a reachable service
- **THEN** the audit reports nothing for it

### Requirement: Legitimate existing occurrences are recorded once and do not churn

The audit SHALL record occurrences it accepts so they stop failing, and SHALL fail on any occurrence it has not recorded. A recorded occurrence SHALL remain accepted when it moves to different lines without changing its syntax, and SHALL be reported again when its syntax changes.

#### Scenario: A recorded occurrence moves

- **WHEN** a recorded occurrence is moved to different lines without changing its syntax
- **THEN** the audit reports nothing for it

#### Scenario: A recorded occurrence is edited

- **WHEN** the syntax of a recorded occurrence changes
- **THEN** the audit reports it until it is recorded again

#### Scenario: Recording an accepted occurrence is deliberate

- **WHEN** the audit records a newly accepted occurrence
- **THEN** it reports success and the recorded set changes only by that occurrence

### Requirement: The audit fails closed on an empty or narrowed corpus

The audit SHALL fail when it admits no files, and when a root the policy declares is absent from the corpus, so a narrowed scan cannot pass silently.

#### Scenario: The corpus is empty

- **WHEN** the audit admits no files
- **THEN** it fails with a diagnostic that names the corpus

#### Scenario: A declared root is missing

- **WHEN** a root the policy declares is absent from the audited corpus
- **THEN** the audit fails rather than reporting success for the remaining roots

### Requirement: The audit is available wherever the required check runs

The audit SHALL run inside the static aggregate behind the required merge check and SHALL be invocable as a package script. One invocation SHALL record accepted occurrences; the other SHALL report a difference without writing.

#### Scenario: A new outbound path reaches the required check

- **WHEN** a change introduces an occurrence the records do not cover
- **THEN** the required check fails and names the finding

#### Scenario: Recording locally

- **WHEN** a maintainer runs the recording invocation
- **THEN** the records are updated and the command reports success

#### Scenario: Records are stale

- **WHEN** the check invocation finds records that no longer match the corpus
- **THEN** it reports the difference and fails
