# Tasks

## 1. Policy declaration and corpus

- [x] 1.1 Create `scripts/private-distribution/policy.ts` holding data only: the 11 removed packages, the retired identifiers, the transport seams with a reason each, the recorded literal hosts grouped by kind (protocol namespace, provider default, package metadata, test placeholder), the compatibility exclusions for session reader and migration paths, and the corpus roots. Verify the module loads with `pnpm exec tsx -e "import('./scripts/private-distribution/policy.ts').then(m => console.log(Object.keys(m)))"` and that every declaration is non-empty.
- [x] 1.2 Create `scripts/private-distribution/corpus.ts` admitting shipped source under `packages`, `apps`, `native`, and `scripts` while excluding `tests/`, fixtures, and build output, and failing when it admits no files or when a declared root contributes nothing. Verify with a spec that builds a temporary git fixture: an empty corpus fails, a fixture missing a declared root fails, and a fixture with one admitted file passes.

## 2. The three rules

- [x] 2.1 Create `scripts/private-distribution/rules/removed-package.ts` reporting a removed package re-mounted in a composition, declared in a manifest, or imported by shipped code, and reporting nothing for a session reader handling a removed producer's event. Verify with a spec covering all four cases.
- [x] 2.2 Create `scripts/private-distribution/rules/retired-identifier.ts` reporting a retired identifier in shipped code and exempting the compatibility paths declared in the policy. Verify with a spec covering a shipped occurrence, a reader-path occurrence, and a test-file occurrence (outside the corpus, so unreported).
- [x] 2.3 Create `scripts/private-distribution/rules/egress.ts` reporting socket, host resolution, and fetch call sites in packages the policy does not declare as transport seams, and a literal host inside a declared seam that the policy does not record. Verify with a spec covering an undeclared package, a seam with a new literal host, a seam building its endpoint from configuration, and a protocol namespace that must not be reported.

## 3. Baseline, reporting, and the executable

- [x] 3.1 Create `scripts/private-distribution/baseline.ts` keying accepted occurrences by a SHA-256 of syntax tokens and diffing them against a scan. Verify with a spec that a moved occurrence stays accepted and an edited occurrence is reported again.
- [x] 3.2 Create `scripts/private-distribution/report.ts` formatting each finding with its rule, repository-relative path, line, and the policy entry that should have covered it. Verify with a spec asserting the format for one finding per rule.
- [x] 3.3 Create `scripts/verify-private-distribution.ts` as the thin entry point: `--check` reports a difference and exits non-zero, the recording mode writes the baseline and exits zero, and a corpus that admits nothing fails in both modes. Verify with a spec that exercises both modes and both failure paths against a temporary fixture.

## 4. Wiring

- [x] 4.1 Add `gen-private-distribution` and `verify-private-distribution` to `package.json` following the existing `gen-*`/`verify-*` pairs. Verify the scripts appear with `node -e "console.log(require('./package.json').scripts['verify-private-distribution'])"`.
- [x] 4.2 Add the audit as a `pnpmScript` leaf in `sharedHygieneGates()` in `scripts/run-gates.ts` so it runs in the `ci-static` aggregate. Verify with `pnpm exec vitest run scripts/run-gates.spec.ts` and by asserting the gate resolves in the aggregate.
- [x] 4.3 Record the initial baseline against the current tree and review every added entry, keeping only occurrences whose reason is legitimate (session reader and migration code, provider ids in tests, protocol namespaces). Verify `pnpm verify-private-distribution` passes and the recorded set stays small enough to read in one review.

## 5. Cleanup of stale artifacts

- [x] 5.1 Collapse the five `x-deepseek-harness` absence assertions in `packages/llm/llm-deepseek/tests` (`adapter.spec.ts`, `loader-composition.spec.ts`, `runtime.spec.ts`) into one per package and keep the assertion that proves the adapter sends no identity headers. Verify with `pnpm exec vitest run packages/llm/llm-deepseek/tests`.
- [x] 5.2 Delete `docs/dependency-catalog.json`, `scripts/dependency-catalog/`, `scripts/gen-dependency-catalog.ts`, `scripts/gen-dependency-catalog.spec.ts`, the two package scripts, the gate entry in `scripts/run-gates.ts`, the assertion in `scripts/run-gates.spec.ts`, and the comment in `scripts/rescope-vendor.ts` that names the generator. Verify `grep -rn dependency-catalog --include='*.ts' --include='*.json' .` returns nothing outside `.git`, and `pnpm exec vitest run scripts/run-gates.spec.ts scripts/rescope-vendor.spec.ts` passes.

## 6. One document, one declaration

- [x] 6.1 Restructure `PRIVATE.md`: state the invariant, describe how the policy is applied, point at the policy module as the only declaration, and keep the synchronization recipe, the review evidence requirement, and the post-merge sweep. Remove the removals prose list, the duplicate "what to bring" rules, and the two audit regexes. Verify that no package name appears twice as a policy list (`grep -c` on the removed package names in the document) and that the documentation gates pass.
- [x] 6.2 Reduce the private distribution section of `AGENTS.md` to the invariant sentence and a link to `PRIVATE.md`. Verify with `pnpm run test:docs` (or the `doc-quick` aggregate) and that the section enumerates no policy entries.

## 7. Upstream synchronization

- [x] 7.1 Merge `upstream/master` into the working branch and resolve the 273 conflicted paths by area (telemetry and analytics, account, uploads and identifiers, web and desktop, CI and workflows, docs and catalogs), keeping the deletion on delete/modify and rename/delete conflicts, with one follow-up commit per area. Verify `git ls-files -u | wc -l` reports zero and the merge commit records both parents.
- [x] 7.2 Delete again the 11 re-introduced packages, the three new packaging and rollout workflows, and the upgrade guides for account surfaces this distribution does not ship. Verify `pnpm verify-private-distribution` passes and none of the 11 package directories exist.
- [x] 7.3 Run `pnpm install`, `pnpm run build:artifacts`, and `pnpm run build:check` on the merged tree, fixing whatever the merge broke in typecheck or bundling. Verify all three commands exit zero.
- [x] 7.4 Re-record the baseline where the merge legitimately moved or added accepted occurrences, and review that diff entry by entry. Verify the recorded set contains no entry under a package the audit should have rejected.
- [x] 7.5 Run the affected package tests, `pnpm run hygiene`, and the documentation gates. Verify each command exits zero and report exactly which commands ran.

## 8. Review evidence

- [x] 8.1 Run the post-merge host sweep from `PRIVATE.md` and review every literal host the merged tree gained, deciding for each whether it is a protocol namespace, a provider default, package metadata, or an outbound path to remove. Verify the reviewed inventory is recorded in the pull request body.
- [x] 8.2 Audit each new upstream package that could reach the network (`host/authentication-token`, `host/authentication-desktop`, `document/office-kit`, `experimental/cua-mcp`, `experimental/deepseek-chat-import`) and confirm none sends data out except through a declared transport seam. Verify the conclusion for each package is recorded in the pull request body.
- [x] 8.3 Open the single pull request carrying the audit output, the host inventory, and the per-package conclusions, and confirm the required `private-ci passed` check is green. Verify the check is green on the final commit.
