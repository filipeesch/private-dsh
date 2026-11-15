/** Run the private-distribution audit over an already discovered corpus. */

import type { CorpusFile } from './corpus.ts'
import type { PrivateDistributionPolicy } from './policy.ts'
import { scanEgress } from './rules/egress.ts'
import { scanRemovedPackages } from './rules/removed-package.ts'
import { scanRetiredIdentifiers } from './rules/retired-identifier.ts'
import type { Finding } from './types.ts'

export type { Finding, RuleId } from './types.ts'

/**
 * Run every rule over the corpus.
 * @param files - audited corpus.
 * @param policy - removal policy the audit enforces.
 * @returns findings ordered by path, line, and rule.
 */
export function scanPrivateDistribution(
  files: readonly CorpusFile[],
  policy: PrivateDistributionPolicy,
): Finding[] {
  const excluded = (path: string): boolean => policy.excludedPaths.some(prefix => path.startsWith(prefix))
  return [
    ...scanRemovedPackages(files, policy),
    ...scanRetiredIdentifiers(files, policy),
    ...scanEgress(files, policy),
  ]
    .filter(finding => !excluded(finding.path))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule))
}
