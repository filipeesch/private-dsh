# Proposal

## Why

The private distribution stays private because nothing leaves the application except the model, search, and plugin requests a user configures. That rule exists only as prose and three overlapping grep patterns in `PRIVATE.md`, and it has no executable form: the same grep reports 161 hits on the current tree, and most are legitimate — 62 are session-log reader and migration code that must stay for old Sessions to load, and 42 are a `feishu` provider id in liveshare tests. A real new outbound path would arrive inside that noise.

The pressure is immediate. `upstream/master` is 1,371 commits ahead (5,645 files changed, 273 conflicted paths) and re-introduces 11 packages this distribution removes, plus three new packaging workflows. Every synchronization so far re-derived the policy from prose and re-verified it by hand, which is where a silent leak would come from.

## What Changes

- **Policy as one typed module.** A policy module owns the removed packages, removed identifiers, transport seams, fixed endpoints, and path exclusions. `PRIVATE.md` describes that policy and points at the module, instead of carrying the same list as removals prose, as "what to bring" rules, and as regexes for a post-merge grep.
- **Executable audit with three scoped rules.** One rule rejects a removed package that is mounted again; one rejects a removed identifier in shipped code outside session reader and migration paths; one rejects network egress from a package that is not a declared transport seam, and a literal host outside the allowlist inside one.
- **Fingerprint baseline.** Pre-existing legitimate occurrences are recorded by syntax fingerprint, so the audit fails only on new occurrences and the baseline does not churn when code moves.
- **Corpus guard.** The audit fails when it admits no files, so a narrowed scan cannot pass silently.
- **CI and local entry point.** The audit joins the static aggregate used by the required check, and gains a package script that also supports recording new policy entries, matching the repository's existing `gen`/`verify` gate pairs.
- **One home for the synchronization recipe.** `PRIVATE.md` owns the recipe, the review evidence requirement, and the post-merge sweep; `AGENTS.md` keeps only the invariant and a link.
- **Catalog removal.** The npm dependency catalog and its generator are deleted (`docs/dependency-catalog.json`, `scripts/dependency-catalog/`, `scripts/gen-dependency-catalog.ts` with its spec, and the gate entry). The catalog describes the package upstream publishes, lists five packages this fork removed, and nothing reads it. **BREAKING** for maintainer tooling: `gen-dependency-catalog` and `verify-dependency-catalog` no longer exist.
- **Assertion collapse.** The five duplicated `x-deepseek-harness` absence assertions in `llm-deepseek` become one per package.
- **Synchronization.** Merge `upstream/master` with the audit already green, keep reader support for persisted Session events whose producers were removed, and do not ship upgrade guides for surfaces this distribution does not have.

## Capabilities

### New Capabilities

- `private-distribution-audit`: the executable form of the distribution invariant — the policy module, the three scoped rules, the fingerprint baseline, the corpus guard, and where the audit runs.
- `upstream-sync-policy`: what a synchronization must satisfy — the single maintainer home for the policy and the recipe, the evidence a review needs, what arrives from upstream by default, and what stays readable or removed.

### Modified Capabilities

None. Existing capabilities (brand presentation, workspace visibility, conversation window) do not change behavior.

## Impact

- **New code:** `scripts/private-distribution/policy.ts`, `scripts/verify-private-distribution.ts`, `scripts/verify-private-distribution.spec.ts`, `scripts/private-distribution.baseline.json`.
- **Wiring:** `package.json`, `scripts/run-gates.ts`, `scripts/run-gates.spec.ts`, and a comment in `scripts/rescope-vendor.ts` that names the deleted generator.
- **Documentation:** `PRIVATE.md` restructured around the policy module and the recipe; `AGENTS.md` link only.
- **Deleted:** the dependency catalog data, its recorded resolution, its generator and spec, and its two package scripts and gate entry.
- **Merged tree:** 5,645 changed files, 273 conflicted paths resolved by area, 11 re-introduced packages removed again, three new packaging workflows dropped, account-surface upgrade guides deleted, and the new upstream features accepted as-is.
- **Unchanged for users:** no application behavior, CLI surface, settings key, or persisted Session format changes. Old Sessions keep loading.
