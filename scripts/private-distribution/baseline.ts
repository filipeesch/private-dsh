/** Record accepted audit occurrences by syntax fingerprint, so only new ones fail. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Finding } from './types.ts'

/** Recorded occurrence counts, keyed by repository path and fingerprint. */
export interface BaselineCounts {
  readonly [file: string]: { readonly [fingerprint: string]: number }
}

/** One observed occurrence, positioned at its line. */
export interface Occurrence {
  /** Repository-relative path with forward slashes. */
  readonly file: string
  /** One-based line the occurrence was found on. */
  readonly line: number
  /** SHA-256 over the rule and its evidence. */
  readonly fingerprint: string
}

/** A recorded entry that no longer matches an observed occurrence. */
export interface StaleEntry {
  /** Repository-relative path the entry names. */
  readonly file: string
  /** Recorded fingerprint. */
  readonly fingerprint: string
  /** How many recorded occurrences remain unmatched. */
  readonly remaining: number
}

const FINGERPRINT = /^[a-f0-9]{64}$/u

/**
 * Compute the fingerprint of one finding.
 * @param finding - observed finding.
 * @returns SHA-256 of the rule and evidence, stable when the occurrence moves between lines.
 */
export function fingerprintOf(finding: Finding): string {
  return createHash('sha256').update(`${finding.rule}\u0000${finding.evidence}`).digest('hex')
}

/**
 * Project findings onto their recorded key.
 * @param findings - observed findings.
 * @returns occurrences in finding order.
 */
export function occurrencesOf(findings: readonly Finding[]): Occurrence[] {
  return findings.map(finding => ({ file: finding.path, line: finding.line, fingerprint: fingerprintOf(finding) }))
}

function sortedEntries<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Count occurrences into the recorded form.
 * @param occurrences - observed occurrences.
 * @returns path and fingerprint counts in stable order.
 */
export function countOccurrences(occurrences: readonly Occurrence[]): BaselineCounts {
  const counts: Record<string, Record<string, number>> = {}
  for (const { file, fingerprint } of occurrences) {
    const perFile = counts[file] ??= {}
    perFile[fingerprint] = (perFile[fingerprint] ?? 0) + 1
  }
  return sortedEntries(Object.fromEntries(Object.entries(counts)
    .map(([file, perFile]) => [file, sortedEntries(perFile)])))
}

/**
 * Compare the recorded set with what the corpus produced, without granting a file-wide allowance.
 * @param baseline - recorded counts.
 * @param occurrences - observed occurrences.
 * @returns occurrences the records do not cover and entries no observation matched.
 */
export function compareBaseline(
  baseline: BaselineCounts,
  occurrences: readonly Occurrence[],
): { added: Occurrence[]; stale: StaleEntry[] } {
  const remaining: Record<string, Record<string, number>> = {}
  for (const [file, perFile] of Object.entries(baseline)) remaining[file] = { ...perFile }
  const added: Occurrence[] = []
  for (const occurrence of occurrences) {
    const perFile = remaining[occurrence.file]
    const allowance = perFile?.[occurrence.fingerprint] ?? 0
    if (perFile !== undefined && allowance > 0) {
      perFile[occurrence.fingerprint] = allowance - 1
      continue
    }
    added.push(occurrence)
  }
  const stale: StaleEntry[] = []
  for (const [file, perFile] of Object.entries(remaining).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [fingerprint, count] of Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))) {
      if (count > 0) stale.push({ file, fingerprint, remaining: count })
    }
  }
  return { added, stale }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and validate a recorded baseline.
 * @param path - absolute path of the baseline file.
 * @returns recorded counts.
 * @throws when the file is not an object of path-to-fingerprint counts.
 */
export function readBaseline(path: string): BaselineCounts {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error('verify-private-distribution: baseline must be a path-to-counts object')
  const counts: Record<string, Record<string, number>> = {}
  for (const [file, perFile] of Object.entries(parsed)) {
    if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..') || !isRecord(perFile)) {
      throw new Error(`verify-private-distribution: invalid baseline entry: ${file}`)
    }
    const entry: Record<string, number> = {}
    for (const [fingerprint, count] of Object.entries(perFile)) {
      if (!FINGERPRINT.test(fingerprint) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`verify-private-distribution: invalid baseline count: ${file}:${fingerprint}`)
      }
      entry[fingerprint] = count
    }
    counts[file] = entry
  }
  return counts
}

/**
 * Write the recorded baseline.
 * @param path - absolute path of the baseline file.
 * @param counts - recorded counts to persist.
 */
export function writeBaseline(path: string, counts: BaselineCounts): void {
  writeFileSync(path, `${JSON.stringify(counts, null, 2)}\n`)
}
