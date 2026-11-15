/** Reject a retired name outside the compatibility paths that keep old Sessions loadable. */

import type { CorpusFile } from '../corpus.ts'
import type { PrivateDistributionPolicy } from '../policy.ts'
import type { Finding } from '../scan.ts'

function exempt(path: string, policy: PrivateDistributionPolicy): boolean {
  return policy.compatibilityPaths.some(prefix => path.startsWith(prefix))
}

/**
 * Find retired identifiers in shipped source outside the compatibility paths.
 * @param files - audited corpus.
 * @param policy - removal policy the audit enforces.
 * @returns findings with the line and the surrounding source line as evidence.
 */
export function scanRetiredIdentifiers(files: readonly CorpusFile[], policy: PrivateDistributionPolicy): Finding[] {
  const findings: Finding[] = []
  for (const file of files) {
    if (file.kind !== 'source' || exempt(file.path, policy)) continue
    const lines = file.text.split('\n')
    lines.forEach((line, index) => {
      for (const identifier of policy.retiredIdentifiers) {
        if (!line.includes(identifier)) continue
        findings.push({
          rule: 'retired-identifier',
          path: file.path,
          line: index + 1,
          evidence: `${identifier}\u0000${line.trim()}`,
          message: `names retired identifier ${identifier}`,
          hint: `${identifier} belongs to a removed surface; keep the removal, or declare the path as a compatibility path if a persisted Session needs it`,
        })
      }
    })
  }
  return findings
}
