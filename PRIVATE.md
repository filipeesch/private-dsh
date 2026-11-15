# Private distribution policy

`filipeesch/dsh-private` tracks `deepseek-ai/deepseek-harness` (remote `upstream`) and stays in sync with it, with one invariant on top: **the application sends nothing to external parties except the model, search, and plugin requests the user configures.** No telemetry, analytics, feedback upload, usage identifiers, Session-log upload, account Sign In, or developer-controlled remote policy.

This file is for maintainers. It states the invariant, points at the one place the removal and egress policy is declared, and records what a synchronization must satisfy. Usage and update instructions for users are in [README.md](README.md#private-distribution).

## The policy is declared once

[scripts/private-distribution/policy.ts](scripts/private-distribution/policy.ts) is the only declaration of what this distribution removes and where network egress is allowed. It holds seven lists:

- **Removed packages.** Packages this distribution does not ship, each with the surface it carried.
- **Retired identifiers.** Names that disappeared with those surfaces.
- **Transport seams.** Packages allowed to start network egress, each with a reason. A provider's endpoint comes from configuration, so adding a provider costs its package plus one seam entry here — not a host registration.
- **Recorded literal hosts.** Hostnames that appear in code inside a seam, grouped by what they identify: protocol namespace, test placeholder, model provider, package metadata, or desktop update origin.
- **Compatibility paths.** Session reader and migration paths that must keep naming retired producers so old Sessions still load.
- **Corpus roots.** The directories the audit reads: `packages`, `apps`, `native`, and `scripts`.
- **Excluded paths.** The audit's own declaration and its records, which name every removed package by definition.

Generated catalogs and package lists derive from the workspace manifests, never from these lists.

## What the audit enforces

`pnpm run verify-private-distribution` runs the audit; `pnpm run gen-private-distribution` records occurrences a maintainer has accepted. The audit is part of the static aggregate behind the required `private-ci passed` check.

Three rules cover shipped source under `packages`, `apps`, `native`, and `scripts` (tests, fixtures, and build output excluded):

1. **A removed package cannot come back**, whether mounted in a composition, declared in a manifest, or imported by code.
2. **A retired identifier cannot return** outside the compatibility paths.
3. **Network egress stays inside a declared transport seam**, and a literal host inside one must be recorded.

Accepted occurrences are recorded by syntax fingerprint, so an occurrence that moves between lines stays accepted and an edited one is reported again. The audit fails closed: an empty corpus, or a declared root that contributes nothing, is a failure rather than a pass.

## Syncing with upstream

Never run `gh repo sync --force`; it resets this repository to upstream and discards every private commit.

```sh
git fetch upstream
git switch master
git merge upstream/master
git push origin master
```

Take everything from upstream — features, fixes, refactors, docs, tests — except what conflicts with the invariant:

- **Removals win the conflict.** Keep a deleted file deleted, and when upstream moved the same behavior elsewhere, remove it there too, adding it to the policy.
- **Drop what needs upstream infrastructure.** Workflows that require upstream runners, secrets, or release feeds do not belong here; a workflow that runs on GitHub-hosted runners without secrets has its useful checks ported into `.github/workflows/private-ci.yml`.
- **Drop documentation for surfaces that do not exist here,** including upgrade guides for removed features.
- **Keep old Sessions loadable.** Persisted events written by removed producers keep their reader support and their compatibility paths.
- **Take upstream defaults** for the model and search providers, and never remove API-key support.
- **When unsure whether a change sends data out, treat it as outbound** until the code proves otherwise.

## What a merge review must show

A synchronization pull request carries three pieces of evidence:

- The output of `pnpm run verify-private-distribution` on the merged tree.
- The reviewed inventory of literal hosts the merge introduced, and the seam entries it added.
- For each new upstream package that could reach the network, the conclusion that it does so only through a declared seam.

A merge with a finding, or without that evidence, is not ready.

## Post-merge sweep

After resolving conflicts, run `pnpm run gen-private-distribution`, then read the resulting diff instead of approving it: every added entry is a statement that an occurrence is legitimate, and every removed entry is a statement that the merge deleted something. Record only what you can justify in one line, and add the justification as a seam reason or a compatibility path rather than leaving it unexplained in the data.
