/** Format private-distribution findings for the terminal and for a pull request body. */

import type { Finding } from './types.ts'

/**
 * Format one finding as an actionable line.
 * @param finding - observed finding.
 * @returns the rule, path, line, message, and what to change.
 */
export function formatFinding(finding: Finding): string {
  return `  ${finding.rule} ${finding.path}:${String(finding.line)}\n    ${finding.message}\n    ${finding.hint}`
}

/**
 * Format findings as a report.
 * @param findings - observed findings.
 * @returns every finding, one block each.
 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map(formatFinding).join('\n')
}
