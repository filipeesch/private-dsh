# Design

## Context

The repository already has the infrastructure this change needs, so the design extends established patterns instead of introducing a framework. See proposal.md for motivation; the requirements live in the two spec deltas.

- **Gate pattern.** `scripts/verify-no-unknown-casts.ts` scans authored source with the TypeScript AST, records accepted occurrences in `scripts/no-unknown-casts.baseline.json` keyed by a SHA-256 of syntax tokens, exports pure functions, and carries a colocated spec that builds temporary git fixtures. Its companion command pair is the repository's convention: `gen-<x>` writes, `verify-<x> --check` fails on a difference.
- **Wiring.** `scripts/run-gates.ts` composes named aggregates from `pnpmScript(...)` leaves; `sharedHygieneGates()` feeds `ci-static`, which the required check runs. `scripts/AGENTS.md` requires gates to resolve paths shell-free, normalize to `/`, use syntax-aware discovery, guard an empty or narrowed corpus, and test every admitted and excluded form.
- **Corpus size.** Shipped code measured on the current tree: 16 packages import `node:net|http|https|tls` and 20 call `fetch` outside tests, with 364 distinct literal hosts overall — 131 of them XML/SVG namespaces that are never reached. A flat host grep cannot separate those.
- **Existing noise.** The maintainer audit reports 161 hits, of which 62 are session reader and migration code that must stay and 42 are a `feishu` provider id in liveshare tests.
- **Upstream distance.** `upstream/master` is 1,371 commits ahead over 5,645 files; a simulated merge reports 273 conflicted paths (151 content, 114 modify/delete, 25 rename/delete).

## Goals / Non-Goals

**Goals:**

- Make the invariant fail-closed and executable, with findings that name rule, path, line, and the policy entry that should have covered it.
- Keep the policy in one typed declaration that a gate reads and a human reads.
- Land the audit before the merge so the merge is judged by a criterion that already existed.
- Leave the merge reviewable: resolve by area, keep removals, and produce evidence.

**Non-Goals:**

- Automating conflict resolution or re-applying the removal branch as patches.
- Retiring the inert `deepseek-llm-api-extensions` seam, which 19 files touch, including the `llm-deepseek` adapter core; removing it would convert a routine merge path into a permanent conflict.
- Modelling a general dependency or network policy for the upstream project; the audit exists for this distribution's invariant only.

## Decisions

### Gate first, merge second, one pull request at the end

The audit lands on the current tree, where it can go green without merge noise; the merge then has to keep it green. The alternative — merge first, then write the gate — was rejected because the criterion would be written while resolving 273 conflicts, which is when a lenient rule is most tempting. A single pull request at the end was chosen so the merge does not arrive with an unreviewed process change; the intermediate commits stay area-scoped for review.

### One policy module, pure scanners, thin entry point

`scripts/private-distribution/policy.ts` holds data only: removed packages, retired identifiers, transport seams with a reason each, recorded literal hosts, compatibility exclusions, and corpus roots. Each rule is its own module (`rules/removed-package.ts`, `rules/retired-identifier.ts`, `rules/egress.ts`) exporting a pure function over an injected corpus; `baseline.ts` owns fingerprinting and diffing; `report.ts` formats findings. The executable `scripts/verify-private-distribution.ts` only wires those together and parses arguments.

This keeps a single responsibility per module, lets each rule be tested against temporary fixtures without touching the filesystem layout of the repository, and avoids the god module a single scanner would become once three rules, a baseline, and two modes live in one file. Alternatives: a JSON data file, rejected because it needs its own validator where TypeScript already checks the declaration, and a Markdown table with a parser, rejected because it adds a second format to keep working.

### Rules scoped by path, not by substring

Rule 1 works from package identity (composition mounts, manifest dependencies, imports). Rule 2 works from identifiers but excludes session reader and migration paths declared in the policy. Rule 3 works from call sites and package identity rather than from host strings. The alternative — one grep over names, which is what the repository does today — cannot separate the 104 legitimate hits from a violation, so a reviewer has to re-derive the rule, which is the problem this change removes.

### Egress is a layer rule with a host allowlist inside the seams

A package that is not declared as a transport seam may not import `node:net|http|https|tls|dns|http2` or call `fetch`. Inside a declared seam, a literal host must be recorded; an endpoint built from configuration needs no entry, which is why adding a model or search provider costs one policy line and no host registration. Literal hosts recorded today fall into four kinds, and the policy labels them: protocol namespaces that are never reached (`w3.org`, `json-schema.org`, `schemas.openxmlformats.org`), provider defaults (`api.deepseek.com`, `*.aliyuncs.com`), package and documentation metadata (`github.com`, registries), and test placeholders that appear in shipped strings (`*.invalid`, `example.com`).

The alternative considered was an allowlist of hosts alone: it lists 364 entries, reports namespaces as violations, and misses a call site whose host comes from configuration. The layer rule is the stronger half and the one that encodes the invariant; the host list only protects the case of a new endpoint inside a seam that is already licensed.

### Fingerprint baseline over line numbers or file allowlists

Recorded occurrences are keyed by a SHA-256 of syntax tokens, following `verify-no-unknown-casts`, so a moved occurrence stays accepted and an edited one is reported again. A line-number baseline churns on every reorder; a file allowlist would accept anything new inside an already-listed file. Each recorded entry carries the rule and a short reason so the diff of a `gen` run reads as a decision.

### Corpus with a guard

Roots are `packages`, `apps`, `native`, and `scripts`, admitting shipped source and excluding `tests/`, fixtures, and generated output. The audit fails when it admits no files, and fails when a declared root contributes nothing, so a narrowed scan cannot pass silently. Tests stay outside the corpus because fixture noise is what makes the current audit unreadable, and `scripts/AGENTS.md` already requires testing every admitted and excluded form.

### One document, one declaration

`PRIVATE.md` keeps the invariant, how the policy is applied, the synchronization recipe, and the review evidence requirement, and points at the policy module for the list. The three representations that exist today — removals prose, "what to bring" rules, and post-merge regexes — collapse into one declaration plus one document. `AGENTS.md` keeps the invariant sentence and the link.

### Review evidence without touching the upstream pull request template

The evidence requirement is a spec requirement and the evidence itself goes in the pull request body under `Testing`/`Proof`, which `dsh-pr-description` already owns. The upstream template stays untouched: it is written in Chinese and carries an AI-declaration table, and editing it would add one more file that every synchronization has to re-resolve for no functional gain.

### Delete the dependency catalog

`docs/dependency-catalog.json` is generated from `scripts/dependency-catalog/resolution.json`, a recorded npm resolution of `@deepseek-ai/dsh` as published upstream on 2026-09-12. Regenerating it cannot remove the five packages this fork deletes, because the published package still contains them. Nothing consumes the artifact — no README, doc page, or website page references it — and this repository's README already tells readers not to use the `npx` path. Keeping it while documenting what it really is was considered and rejected: it would leave a maintained artifact that asserts this repository installs packages it does not. The cost is accepted: the generator, its spec, its data, its two package scripts, its gate entry in `scripts/run-gates.ts`, the assertion in `scripts/run-gates.spec.ts`, and the comment in `scripts/rescope-vendor.ts` that names the generator.

### Deliberately kept

- The sign-out branch in `turn-error.ts` keeps old Sessions readable and has a test; it is compatibility, not residue.
- Session reader and migration modules, persistence catalogs, upgrade guides for surfaces this distribution does keep, and the archived notes stay untouched.
- The duplicated header-absence assertions collapse to one per package, but the remaining one stays: it proves the adapter does not send the identity headers, which is behavior, not an absence string.

### Merge shape

A single merge of `upstream/master` on the working branch, resolved manual by area, with follow-up commits named per area (telemetry and analytics, account, uploads and identifiers, web and desktop, CI and workflows, docs and catalogs). Delete/modify conflicts keep the deletion; rename/delete conflicts keep the deletion at both ends. The merge is not squashed and the private commits are not rebased: rebasing 39 commits over 5,645 changed files would repeat the same conflict resolution many times and lose the merge ancestry that makes the next synchronization a fast-forward-aware merge.

## Risks / Trade-offs

- **A recorded fingerprint masks a real regression** → each entry carries its rule and reason, the recording command prints the added entries, and the pull request shows the baseline diff. The baseline is reviewed like code.
- **The layer rule produces a large first baseline** (16 net-importing packages, 20 fetch callers) → the first recording is a review artifact of its own, with one reason per seam. Anything that cannot state a reason is not recorded, and stays a finding.
- **The audit lands before a merge that touches its own corpus** → the merge will move session code and add packages, so some entries become stale and re-recording is expected. Fingerprints survive pure movement; only edited occurrences need re-recording.
- **A strict egress rule blocks a legitimate new upstream feature** → the feature enters as a declared seam with one policy line, which is a deliberate review checkpoint rather than a wall. The cost of adding a provider is the provider package, its configuration, and one line.
- **Deleting the catalog creates a permanent delete/modify conflict with upstream** → accepted, matching every other removal in this distribution; the alternative leaves an artifact that misstates the fork.
- **The merge itself can leave the tree unbuildable in ways the audit cannot see** → verification order: `pnpm install`, `build:artifacts`, `build:check`, the affected package tests, `hygiene`, `doc-sync`/`test:docs`, the dependency greps, then the required check for the matrix.

## Migration Plan

1. Land the policy module, the three rules, the baseline, the wiring, and the tests on the current tree; the audit must pass there.
2. Collapse the assertions and delete the dependency catalog with its wiring, updating the spec that asserts the gate exists.
3. Restructure `PRIVATE.md` around the policy module and the recipe; reduce `AGENTS.md` to the invariant and a link.
4. Merge `upstream/master`, resolve by area, delete reintroduced packages and upstream-only workflows, and delete upgrade guides for removed surfaces.
5. Re-record the baseline where the merge legitimately moved or added accepted occurrences, and review that diff.
6. Run the verification order above and open one pull request carrying the audit output and the host inventory.

Rollback: the gate, the cleanup, and the documentation are independent commits that revert cleanly; the merge is a single commit that reverts as a unit, restoring the pre-sync tree.

## Open Questions

None blocking. Deferred by decision: retiring the inert `deepseek-llm-api-extensions` seam, and automating re-application of removals, which was considered and left out of scope.
