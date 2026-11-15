/** Enforce the private distribution's invariant over the shipped corpus. */

import { resolve } from 'node:path'
import {
  compareBaseline,
  countOccurrences,
  fingerprintOf,
  occurrencesOf,
  readBaseline,
  writeBaseline,
  type BaselineCounts,
  type Occurrence,
  type StaleEntry,
} from './private-distribution/baseline.ts'
import { readCorpus } from './private-distribution/corpus.ts'
import { POLICY, type PrivateDistributionPolicy } from './private-distribution/policy.ts'
import { formatFindings } from './private-distribution/report.ts'
import { scanPrivateDistribution, type Finding } from './private-distribution/scan.ts'

const root = resolve(import.meta.dirname, '..')

/** Repository-relative path of the recorded baseline. */
export const BASELINE_PATH = 'scripts/private-distribution.baseline.json'

/** What the audit does with its records. */
export type AuditMode = 'check' | 'record'

/** What one audit run observed. */
export interface AuditResult {
  /** Every finding the corpus produced. */
  readonly findings: readonly Finding[]
  /** Findings the records do not cover. */
  readonly added: readonly Occurrence[]
  /** Recorded entries no observation matched. */
  readonly stale: readonly StaleEntry[]
}

function baselineFile(repoRoot: string, baselinePath: string): string {
  return resolve(repoRoot, baselinePath)
}

/**
 * Scan the corpus and compare it with the recorded baseline.
 * @param repoRoot - repository root containing the Git index.
 * @param policy - policy the audit enforces.
 * @param baselinePath - repository-relative path of the recorded baseline.
 * @returns findings and how they compare with the records.
 * @throws when the corpus is empty or a declared root contributes nothing.
 */
export function audit(
  repoRoot: string,
  policy: PrivateDistributionPolicy = POLICY,
  baselinePath: string = BASELINE_PATH,
): AuditResult {
  const findings = scanPrivateDistribution(readCorpus(repoRoot, policy.corpusRoots), policy)
  const baseline = readBaseline(baselineFile(repoRoot, baselinePath))
  const { added, stale } = compareBaseline(baseline, occurrencesOf(findings))
  return { findings, added, stale }
}

/**
 * Fail when the corpus produced an occurrence the records do not cover, or left a stale record.
 * @param repoRoot - repository root containing the Git index.
 * @param policy - policy the audit enforces.
 * @param baselinePath - repository-relative path of the recorded baseline.
 * @returns every finding the corpus produced.
 * @throws with the added occurrences and the stale records when they differ.
 */
export function check(
  repoRoot: string,
  policy: PrivateDistributionPolicy = POLICY,
  baselinePath: string = BASELINE_PATH,
): readonly Finding[] {
  const { findings, added, stale } = audit(repoRoot, policy, baselinePath)
  if (added.length > 0) {
    const byFingerprint = new Map(findings.map(finding => [`${finding.path}\0${fingerprintOf(finding)}`, finding]))
    const detail = added
      .map(occurrence => byFingerprint.get(`${occurrence.file}\0${occurrence.fingerprint}`))
      .filter((finding): finding is Finding => finding !== undefined)
    throw new Error('verify-private-distribution: the private invariant is not satisfied.\n'
      + `${formatFindings(detail)}\n`
      + '  Remove the occurrence, declare a transport seam, record the host, or add a compatibility path.')
  }
  if (stale.length > 0) {
    throw new Error('verify-private-distribution: recorded occurrences no longer match the corpus.\n'
      + stale.map(entry => `  ${entry.file} (${entry.fingerprint}) x${String(entry.remaining)}`).join('\n')
      + '\n  Re-record with pnpm run gen-private-distribution.')
  }
  return findings
}

/**
 * Record every occurrence the corpus currently produces.
 * @param repoRoot - repository root containing the Git index.
 * @param policy - policy the audit enforces.
 * @param baselinePath - repository-relative path of the recorded baseline.
 * @returns the recorded counts.
 * @throws when the corpus is empty or a declared root contributes nothing.
 */
export function record(
  repoRoot: string,
  policy: PrivateDistributionPolicy = POLICY,
  baselinePath: string = BASELINE_PATH,
): BaselineCounts {
  const findings = scanPrivateDistribution(readCorpus(repoRoot, policy.corpusRoots), policy)
  const baseline = readBaseline(baselineFile(repoRoot, baselinePath))
  const { added } = compareBaseline(baseline, occurrencesOf(findings))
  for (const occurrence of added) {
    process.stdout.write(`  recorded ${occurrence.file}:${String(occurrence.line)} (${occurrence.fingerprint})\n`)
  }
  const counts = countOccurrences(occurrencesOf(findings))
  writeBaseline(baselineFile(repoRoot, baselinePath), counts)
  return counts
}

/**
 * Read the audit mode from command-line arguments.
 * @param args - arguments after the script path.
 * @returns the requested mode; no argument means check.
 * @throws for an unknown argument.
 */
export function parseMode(args: readonly string[]): AuditMode {
  if (args.length === 0) return 'check'
  if (args.length === 1 && args[0] === '--check') return 'check'
  if (args.length === 1 && args[0] === '--record') return 'record'
  throw new Error('Usage: pnpm run verify-private-distribution [--check | --record]')
}

function main(): void {
  try {
    const mode = parseMode(process.argv.slice(2))
    if (mode === 'record') {
      const counts = record(root)
      const total = Object.values(counts).reduce((sum, perFile) => sum + Object.values(perFile).reduce((a, b) => a + b, 0), 0)
      console.log(`verify-private-distribution: recorded ${String(total)} occurrences across ${String(Object.keys(counts).length)} files.`)
      return
    }
    const findings = check(root)
    console.log(`verify-private-distribution: no new occurrences; ${String(findings.length)} recorded occurrences remain.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
