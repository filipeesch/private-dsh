/** Discover the shipped corpus the private-distribution audit scans. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** One audited file: shipped source, or a composition or package manifest. */
export interface CorpusFile {
  /** Repository-relative path with forward slashes. */
  readonly path: string
  /** File contents. */
  readonly text: string
  /** Whether the file carries source or declares composition and dependencies. */
  readonly kind: 'source' | 'manifest'
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const MANIFEST_FILE = /(?:^|\/)(?:package\.json|cordis\.ya?ml|cordis\.patch\.ya?ml)$/u
const TEST_FILE = /\.(?:spec|test|e2e)\.[cm]?[jt]sx?$/u
const EXCLUDED_SEGMENTS = new Set(['tests', 'fixtures', 'node_modules', 'lib', 'dist', 'coverage'])

function segments(path: string): string[] {
  return path.split('/')
}

/**
 * Decide whether one repository path belongs to the audited corpus.
 * @param roots - top-level roots the policy declares.
 * @param path - repository-relative path with forward slashes.
 * @returns true when the path is shipped source or a shipped manifest under a declared root.
 */
export function admits(roots: readonly string[], path: string): boolean {
  if (!roots.some(root => path.startsWith(`${root}/`))) return false
  const parts = segments(path)
  if (parts.some(part => EXCLUDED_SEGMENTS.has(part))) return false
  if (TEST_FILE.test(path)) return false
  return SOURCE_FILE.test(path) || MANIFEST_FILE.test(path)
}

/**
 * List the audited corpus, failing closed when a declared root contributes nothing.
 * @param repoRoot - repository root containing the Git index.
 * @param roots - top-level roots the policy declares.
 * @returns sorted repository-relative paths admitted by the policy.
 * @throws when the corpus is empty, a declared root contributes no file, or a path is a symlink.
 */
export function discoverCorpus(repoRoot: string, roots: readonly string[]): string[] {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).split('\0').map(path => path.replaceAll('\\', '/'))
  const admitted = [...new Set(tracked.filter(path => admits(roots, path)))].sort()
  for (const root of roots) {
    if (!admitted.some(path => path.startsWith(`${root}/`))) {
      throw new Error(`verify-private-distribution: corpus omitted declared root ${root}`)
    }
  }
  if (admitted.length === 0) throw new Error('verify-private-distribution: corpus is empty')
  return admitted
}

/**
 * Read the audited corpus.
 * @param repoRoot - repository root containing the Git index.
 * @param roots - top-level roots the policy declares.
 * @returns every admitted file with its contents and kind.
 * @throws when a corpus path is a symlink or unreadable.
 */
export function readCorpus(repoRoot: string, roots: readonly string[]): CorpusFile[] {
  return discoverCorpus(repoRoot, roots).flatMap((path) => {
    const absolute = resolve(repoRoot, path)
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() === true) throw new Error(`verify-private-distribution: corpus symlink is unsupported: ${path}`)
    if (stat?.isFile() !== true) return []
    return [{ path, text: readFileSync(absolute, 'utf8'), kind: SOURCE_FILE.test(path) ? 'source' as const : 'manifest' as const }]
  })
}
