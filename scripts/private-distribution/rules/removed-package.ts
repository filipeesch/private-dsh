/** Reject a package this distribution removed when it is mounted, depended on, or imported again. */

import ts from 'typescript'
import type { CorpusFile } from '../corpus.ts'
import type { PrivateDistributionPolicy } from '../policy.ts'
import type { Finding } from '../scan.ts'

const PREFIX = '@deepseek-ai/dsh-'

function bareName(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

function removedMatches(specifier: string, policy: PrivateDistributionPolicy): string | undefined {
  return policy.removedPackages.find(({ name }) => specifier === name || specifier.startsWith(`${name}/`))?.name
}

function sourceFindings(file: CorpusFile, policy: PrivateDistributionPolicy): Finding[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  const report = (specifier: string, position: number): void => {
    const removed = removedMatches(specifier, policy)
    if (removed === undefined) return
    findings.push({
      rule: 'removed-package',
      path: file.path,
      line: lineAt(source, position),
      evidence: `import ${removed}`,
      message: `imports removed package ${removed}`,
      hint: `${removed} is removed by this distribution; keep the removal instead of restoring the import`,
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      report(node.moduleSpecifier.text, node.getStart(source))
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      report(node.moduleSpecifier.text, node.getStart(source))
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const [argument] = node.arguments
      if ((isDynamicImport || isRequire) && argument !== undefined && ts.isStringLiteralLike(argument)) {
        report(argument.text, node.getStart(source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

function manifestFindings(file: CorpusFile, policy: PrivateDistributionPolicy): Finding[] {
  if (!file.path.endsWith('package.json')) return compositionFindings(file, policy)
  const parsed: unknown = JSON.parse(file.text)
  const findings: Finding[] = []
  if (!isRecord(parsed)) return findings
  for (const map of DEPENDENCY_MAPS) {
    const section = parsed[map]
    if (!isRecord(section)) continue
    for (const name of Object.keys(section)) {
      if (removedMatches(name, policy) === undefined) continue
      findings.push({
        rule: 'removed-package',
        path: file.path,
        line: 1,
        evidence: `dependency ${name}`,
        message: `declares a dependency on removed package ${name}`,
        hint: `${name} is removed by this distribution; drop the dependency`,
      })
    }
  }
  return findings
}

const COMPOSITION_KEY = /^\s*(?:-\s*)?['"]?([@\w./-]+)['"]?\s*:/u

function compositionFindings(file: CorpusFile, policy: PrivateDistributionPolicy): Finding[] {
  const findings: Finding[] = []
  file.text.split('\n').forEach((line, index) => {
    const match = COMPOSITION_KEY.exec(line)
    if (match === null) return
    const key = match[1] ?? ''
    const removed = policy.removedPackages.find(({ name }) => key === name || key === bareName(name))
    if (removed === undefined) return
    findings.push({
      rule: 'removed-package',
      path: file.path,
      line: index + 1,
      evidence: `mount ${removed.name}`,
      message: `mounts removed package ${removed.name}`,
      hint: `drop this row; ${removed.name} is removed by this distribution`,
    })
  })
  return findings
}

/**
 * Find removed packages that are mounted, depended on, or imported again.
 * @param files - audited corpus.
 * @param policy - removal policy the audit enforces.
 * @returns findings in corpus order; a session reader naming a removed producer's event is not a finding.
 */
export function scanRemovedPackages(files: readonly CorpusFile[], policy: PrivateDistributionPolicy): Finding[] {
  return files.flatMap(file => file.kind === 'source' ? sourceFindings(file, policy) : manifestFindings(file, policy))
}
