# upstream-sync-policy Specification

## Purpose
Defines what a synchronization with upstream must satisfy so the private invariant survives a merge instead of being re-derived from prose, and so each merge is reviewable through evidence.

## Requirements

### Requirement: The removal policy has one home

The removed packages, the retired identifiers, the transport seams, the recorded literal hosts, and the compatibility exclusions SHALL be declared in exactly one place. The maintainer document SHALL describe that policy without restating it as a second list, and the repository instructions SHALL carry the invariant and a link only.

#### Scenario: A package becomes removed

- **WHEN** a maintainer adds a package to the removal policy
- **THEN** exactly one declaration changes

#### Scenario: The maintainer document describes the policy

- **WHEN** a reader opens the maintainer document
- **THEN** it states the invariant, describes how the policy is applied, and points at the single declaration instead of repeating it

#### Scenario: Instructions stay a link

- **WHEN** a reader opens the repository instructions
- **THEN** they state the invariant and link the maintainer document, and do not enumerate the policy

### Requirement: A synchronization is accepted only with the audit green and the sweep reviewed

A merge from upstream SHALL NOT be accepted while the distribution audit reports a finding. The pull request SHALL carry the audit result and the reviewed inventory of literal hosts as evidence.

#### Scenario: A merge introduces an outbound path

- **WHEN** a merge leaves a finding from the distribution audit
- **THEN** the merge is not accepted

#### Scenario: The review lacks evidence

- **WHEN** a merge pull request carries neither the audit result nor the reviewed host inventory
- **THEN** the merge is not accepted

#### Scenario: Evidence accompanies the merge

- **WHEN** the audit passes and the pull request records the audit result and the reviewed host inventory
- **THEN** the merge may be accepted

### Requirement: Removals win the conflict, wherever upstream moved the behavior

When a merge conflicts on a file this distribution removed, the removal SHALL be kept. When upstream moves the same outbound behavior elsewhere, the merge SHALL remove it there as well.

#### Scenario: A deleted file is modified upstream

- **WHEN** upstream modifies a file this distribution removed
- **THEN** the file stays absent from the merged tree

#### Scenario: Upstream relocates removed behavior

- **WHEN** upstream moves the behavior of a removed package or feature into a surviving package
- **THEN** the merge removes it from the new location too

### Requirement: Persisted Session data from removed producers stays readable

Sessions written before a producer was removed SHALL continue to load after a synchronization. Reader and migration support for those events and for the identity values they carry SHALL stay.

#### Scenario: An older Session is opened

- **WHEN** a Session whose events name a removed producer is loaded
- **THEN** it loads without a migration error

#### Scenario: Display code handles a removed sign-out reason

- **WHEN** a turn ended because of a removed account surface is displayed
- **THEN** the recorded reason still produces its failure row

### Requirement: Surfaces this distribution does not have ship no documentation or CI

A synchronization SHALL NOT leave upgrade guides for removed surfaces, and SHALL NOT keep a workflow that needs upstream runners or secrets. A new workflow SHALL be dropped unless it runs on GitHub-hosted runners without upstream secrets, in which case its useful checks move into this distribution's own workflow.

#### Scenario: Documentation for a removed surface arrives

- **WHEN** upstream adds an upgrade guide for a surface this distribution removes
- **THEN** the merge deletes that guide

#### Scenario: A workflow needs upstream infrastructure

- **WHEN** upstream adds a workflow that requires upstream runners or secrets
- **THEN** the merge drops it

#### Scenario: A workflow runs on hosted runners

- **WHEN** upstream adds a workflow that runs on GitHub-hosted runners without upstream secrets
- **THEN** its useful checks are ported into this distribution's own workflow

### Requirement: Everything else arrives by default

A synchronization SHALL take upstream's features, fixes, refactors, tests, and documentation unless they conflict with the invariant. Upstream's defaults for the model provider and the search provider SHALL be taken, and API-key support SHALL NOT be removed.

#### Scenario: A new feature arrives

- **WHEN** upstream adds a package that sends nothing anywhere except through a declared transport seam
- **THEN** the merge keeps it

#### Scenario: Upstream changes a provider default

- **WHEN** upstream changes the default model provider or search provider
- **THEN** the merge takes upstream's value

#### Scenario: Upstream drops API-key support

- **WHEN** a synchronization would remove API-key support for the model provider or the search and fetch providers
- **THEN** that removal is not accepted
