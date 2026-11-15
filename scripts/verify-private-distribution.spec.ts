import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareBaseline, countOccurrences, occurrencesOf } from './private-distribution/baseline.ts'
import { admits, discoverCorpus, readCorpus, type CorpusFile } from './private-distribution/corpus.ts'
import type { PrivateDistributionPolicy } from './private-distribution/policy.ts'
import { scanEgress } from './private-distribution/rules/egress.ts'
import { scanRemovedPackages } from './private-distribution/rules/removed-package.ts'
import { scanRetiredIdentifiers } from './private-distribution/rules/retired-identifier.ts'
import { formatFindings } from './private-distribution/report.ts'
import { scanPrivateDistribution, type Finding } from './private-distribution/scan.ts'
import { check, parseMode, record } from './verify-private-distribution.ts'

const roots: string[] = []
const baselinePath = 'scripts/test-private-distribution.baseline.json'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function policy(overrides: Partial<PrivateDistributionPolicy> = {}): PrivateDistributionPolicy {
  return {
    corpusRoots: ['packages'],
    removedPackages: [{ name: '@deepseek-ai/dsh-removed-thing', reason: 'removed for the test' }],
    retiredIdentifiers: ['removed-marker'],
    transportSeams: [{ path: 'packages/seam', kind: 'model-provider', reason: 'test seam' }],
    recordedHosts: [
      { host: 'api.example.org', kind: 'model-provider' },
      { host: 'www.w3.org', kind: 'protocol-namespace' },
    ],
    compatibilityPaths: ['packages/reader/'],
    excludedPaths: [],
    ...overrides,
  }
}

function file(path: string, text: string, kind: 'source' | 'manifest' = 'source'): CorpusFile {
  return { path, text, kind }
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-private-distribution-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
  for (const [path, contents] of Object.entries(files)) write(root, path, contents)
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' })
  return root
}

function rules(findings: readonly Finding[]): string[] {
  return findings.map(finding => finding.rule)
}

describe('report', () => {
  it('prints one block per rule with the path, line, message, and fix', () => {
    const findings: readonly Finding[] = [
      { rule: 'egress', path: 'packages/a/src/x.ts', line: 4, evidence: 'fetch(u)', message: 'calls fetch', hint: 'declare a seam' },
      { rule: 'removed-package', path: 'packages/a/package.json', line: 9, evidence: '"dsh-removed"', message: 'depends on removed', hint: 'drop it' },
      { rule: 'retired-identifier', path: 'packages/a/src/y.ts', line: 2, evidence: 'anonymousId', message: 'names retired', hint: 'rename it' },
    ]
    const report = formatFindings(findings)
    expect(report.split('\n').filter(line => line.startsWith('  ') && !line.startsWith('    '))).toHaveLength(3)
    expect(report).toContain('egress packages/a/src/x.ts:4')
    expect(report).toContain('removed-package packages/a/package.json:9')
    expect(report).toContain('retired-identifier packages/a/src/y.ts:2')
    expect(report).toContain('declare a seam')
    expect(report).toContain('drop it')
    expect(report).toContain('rename it')
  })
})

describe('corpus', () => {
  it('admits shipped source and manifests under a declared root', () => {
    expect(admits(['packages'], 'packages/app/src/index.ts')).toBe(true)
    expect(admits(['packages'], 'packages/app/src/index.tsx')).toBe(true)
    expect(admits(['packages'], 'packages/app/package.json')).toBe(true)
    expect(admits(['packages'], 'packages/app/cordis.yml')).toBe(true)
    expect(admits(['packages'], 'packages/app/cordis.patch.yml')).toBe(true)
  })

  it('excludes tests, fixtures, generated output, and other roots', () => {
    expect(admits(['packages'], 'packages/app/tests/index.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/src/index.spec.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/src/index.e2e.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/src/index.test.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/fixtures/index.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/lib/index.js')).toBe(false)
    expect(admits(['packages'], 'packages/app/node_modules/app/index.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/dist/index.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/coverage/index.ts')).toBe(false)
    expect(admits(['packages'], 'apps/web/index.ts')).toBe(false)
    expect(admits(['packages'], 'packages/app/README.md')).toBe(false)
  })

  it('fails when a declared root contributes nothing', () => {
    const root = fixture({ 'packages/app/src/index.ts': 'export {}\n' })
    expect(() => discoverCorpus(root, ['packages', 'apps'])).toThrow(/omitted declared root apps/u)
  })

  it('fails when the corpus is empty', () => {
    const root = fixture({ 'README.md': '# none\n' })
    expect(() => discoverCorpus(root, [])).toThrow(/corpus is empty/u)
  })

  it('reads the admitted files with their kind', () => {
    const root = fixture({
      'packages/app/src/index.ts': 'export {}\n',
      'packages/app/package.json': '{}\n',
      'packages/app/tests/index.ts': 'export {}\n',
    })
    const corpus = readCorpus(root, ['packages'])
    expect(corpus.map(entry => entry.path)).toEqual(['packages/app/package.json', 'packages/app/src/index.ts'])
    expect(corpus.map(entry => entry.kind)).toEqual(['manifest', 'source'])
  })
})

describe('removed package rule', () => {
  it('reports an import of a removed package', () => {
    const findings = scanRemovedPackages(
      [file('packages/app/src/index.ts', "import thing from '@deepseek-ai/dsh-removed-thing'\n")],
      policy(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
    expect(findings[0]?.message).toContain('@deepseek-ai/dsh-removed-thing')
  })

  it('reports a dynamic import and a require', () => {
    const findings = scanRemovedPackages([
      file('packages/app/src/a.ts', "const a = await import('@deepseek-ai/dsh-removed-thing/sub')\n"),
      file('packages/app/src/b.ts', "const b = require('@deepseek-ai/dsh-removed-thing')\n"),
    ], policy())
    expect(findings.map(finding => finding.path)).toEqual(['packages/app/src/a.ts', 'packages/app/src/b.ts'])
  })

  it('reports a manifest dependency on a removed package', () => {
    const findings = scanRemovedPackages([
      file('packages/app/package.json', JSON.stringify({ dependencies: { '@deepseek-ai/dsh-removed-thing': '1.0.0' } }), 'manifest'),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('dependency')
  })

  it('reports a composition row naming a removed package', () => {
    const findings = scanRemovedPackages([
      file('packages/app/cordis.patch.yml', [
        '    - id: ui-thing',
        "      name: '@deepseek-ai/dsh-removed-thing'",
        '      config: {}',
        '',
      ].join('\n'), 'manifest'),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(2)
  })

  it('reports a composition row whose id names a removed package without its scope', () => {
    const findings = scanRemovedPackages([
      file('packages/app/cordis.patch.yml', '    - id: removed-thing\n', 'manifest'),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('reports a mapping-form composition mounting a removed package by bare name', () => {
    const findings = scanRemovedPackages([
      file('packages/app/cordis.yml', 'plugins:\n  removed-thing:\n    enabled: true\n', 'manifest'),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(2)
  })

  it('ignores composition row fields that are not plugin names', () => {
    const findings = scanRemovedPackages([
      file('packages/app/cordis.patch.yml', [
        '    - id: kept-thing',
        '      name: kept-thing',
        '      config:',
        '        source: removed-thing',
        '',
      ].join('\n'), 'manifest'),
    ], policy())
    expect(findings).toEqual([])
  })

  it('reports nothing when a session reader names a removed producer event', () => {
    const findings = scanRemovedPackages([
      file('packages/reader/src/read.ts', "const type = 'removed-thing/delivery-accepted'\n"),
    ], policy())
    expect(findings).toEqual([])
  })
})

describe('retired identifier rule', () => {
  it('reports a retired identifier in shipped code', () => {
    const findings = scanRetiredIdentifiers([
      file('packages/app/src/index.ts', "const value = 'removed-marker'\n"),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('reports once per identifier per line', () => {
    const findings = scanRetiredIdentifiers([
      file('packages/app/src/index.ts', "const a = 'removed-marker'\nconst b = 'removed-marker'\n"),
    ], policy())
    expect(findings.map(finding => finding.line)).toEqual([1, 2])
  })

  it('exempts a compatibility path', () => {
    const findings = scanRetiredIdentifiers([
      file('packages/reader/src/read.ts', "const value = 'removed-marker'\n"),
    ], policy())
    expect(findings).toEqual([])
  })

  it('leaves a test file outside the corpus unreported', () => {
    const root = fixture({
      'packages/app/tests/index.spec.ts': "const value = 'removed-marker'\n",
      'packages/app/src/index.ts': 'export {}\n',
    })
    const findings = scanPrivateDistribution(readCorpus(root, ['packages']), policy())
    expect(findings).toEqual([])
  })
})

describe('scan', () => {
  it('excludes the audit declaration itself', () => {
    const auditPolicy = policy({ excludedPaths: ['packages/policy/'] })
    const findings = scanPrivateDistribution([
      file('packages/policy/policy.ts', "export const retired = ['removed-marker']\n"),
      file('packages/app/src/index.ts', "const value = 'removed-marker'\n"),
    ], auditPolicy)
    expect(findings.map(finding => finding.path)).toEqual(['packages/app/src/index.ts'])
  })
})

describe('egress rule', () => {
  it('reports fetch outside a declared transport seam', () => {
    const findings = scanEgress([
      file('packages/app/src/index.ts', "const response = await fetch('https://api.example.org/x')\n"),
    ], policy())
    expect(rules(findings)).toEqual(['egress'])
    expect(findings[0]?.message).toContain('fetch')
  })

  it('reports a network module import outside a declared transport seam', () => {
    const findings = scanEgress([
      file('packages/app/src/index.ts', "import { request } from 'node:https'\n"),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('node:https')
  })

  it('reports a literal host a transport seam does not record', () => {
    const findings = scanEgress([
      file('packages/seam/src/index.ts', "const url = 'https://evil.example.net/v1'\n"),
    ], policy())
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('evil.example.net')
  })

  it('accepts a recorded host and a configured endpoint inside a seam', () => {
    const findings = scanEgress([
      file('packages/seam/src/index.ts', "const a = 'https://api.example.org/v1'\nconst b = config.baseUrl\n"),
    ], policy())
    expect(findings).toEqual([])
  })

  it('accepts a recorded protocol namespace inside a seam', () => {
    const findings = scanEgress([
      file('packages/seam/src/index.ts', "const ns = 'https://www.w3.org/2000/svg'\n"),
    ], policy())
    expect(findings).toEqual([])
  })
})

describe('baseline', () => {
  const finding = (line: number, evidence = 'call fetch'): Finding => ({
    rule: 'egress',
    path: 'packages/app/src/index.ts',
    line,
    evidence,
    message: 'm',
    hint: 'h',
  })

  it('keeps a recorded occurrence accepted when it moves', () => {
    const recorded = countOccurrences(occurrencesOf([finding(3)]))
    const comparison = compareBaseline(recorded, occurrencesOf([finding(11)]))
    expect(comparison.added).toEqual([])
    expect(comparison.stale).toEqual([])
  })

  it('reports an edited occurrence again', () => {
    const recorded = countOccurrences(occurrencesOf([finding(3)]))
    const comparison = compareBaseline(recorded, occurrencesOf([finding(3, 'import node:https')]))
    expect(comparison.added).toHaveLength(1)
    expect(comparison.stale).toHaveLength(1)
  })

  it('does not grant a file-wide allowance', () => {
    const recorded = countOccurrences(occurrencesOf([finding(3)]))
    const comparison = compareBaseline(recorded, occurrencesOf([finding(3), finding(40)]))
    expect(comparison.added).toHaveLength(1)
  })
})

describe('audit modes', () => {
  function audited(): Record<string, string> {
    return {
      'scripts/test-private-distribution.baseline.json': '{}\n',
      'packages/app/src/index.ts': "export const load = async (): Promise<Response> => fetch('https://api.example.org/x')\n",
    }
  }

  it('fails when the corpus produces an occurrence the records do not cover', () => {
    const root = fixture(audited())
    expect(() => check(root, policy(), baselinePath)).toThrow(/private invariant is not satisfied/u)
  })

  it('records occurrences and then passes the check', () => {
    const root = fixture(audited())
    const counts = record(root, policy(), baselinePath)
    expect(Object.keys(counts)).toEqual(['packages/app/src/index.ts'])
    expect(readFileSync(join(root, baselinePath), 'utf8')).toContain('packages/app/src/index.ts')
    expect(check(root, policy(), baselinePath)).toHaveLength(1)
  })

  it('reports an edited occurrence as new', () => {
    const root = fixture(audited())
    record(root, policy(), baselinePath)
    write(root, 'packages/app/src/index.ts', "export const load = async (): Promise<Response> => fetch('https://api.example.org/y')\n")
    expect(() => check(root, policy(), baselinePath)).toThrow(/private invariant is not satisfied/u)
  })

  it('fails when a recorded occurrence disappears', () => {
    const root = fixture(audited())
    record(root, policy(), baselinePath)
    write(root, 'packages/app/src/index.ts', 'export {}\n')
    expect(() => check(root, policy(), baselinePath)).toThrow(/no longer match/u)
  })

  it('fails closed when a declared root contributes nothing', () => {
    const root = fixture({ 'scripts/test-private-distribution.baseline.json': '{}\n' })
    expect(() => check(root, policy(), baselinePath)).toThrow(/omitted declared root packages/u)
  })

  it('parses its mode from the command line', () => {
    expect(parseMode([])).toBe('check')
    expect(parseMode(['--check'])).toBe('check')
    expect(parseMode(['--record'])).toBe('record')
    expect(() => parseMode(['--other'])).toThrow(/Usage/u)
  })
})
