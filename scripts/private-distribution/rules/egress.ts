/** Confine network egress to declared transport seams and recorded literal hosts. */

import ts from 'typescript'
import type { CorpusFile } from '../corpus.ts'
import type { PrivateDistributionPolicy, TransportSeam } from '../policy.ts'
import type { Finding } from '../scan.ts'

const NETWORK_MODULES = new Set(['node:net', 'node:http', 'node:https', 'node:tls', 'node:dns', 'node:http2'])
const HOST = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gu

function seamFor(path: string, policy: PrivateDistributionPolicy): TransportSeam | undefined {
  return policy.transportSeams.find(({ path: prefix }) => path === prefix || path.startsWith(`${prefix}/`))
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

function lineText(source: ts.SourceFile, line: number): string {
  return source.text.split('\n')[line - 1]?.trim() ?? ''
}

function egressFindings(file: CorpusFile): Finding[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  const report = (message: string, position: number): void => {
    const line = lineAt(source, position)
    findings.push({
      rule: 'egress',
      path: file.path,
      line,
      evidence: lineText(source, line),
      message,
      hint: 'declare this package as a transport seam with a reason in scripts/private-distribution/policy.ts, or stop the call',
    })
  }
  const visit = (node: ts.Node): void => {
    const moduleSpecifier = ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined
    if (moduleSpecifier !== undefined && NETWORK_MODULES.has(moduleSpecifier)) {
      report(`imports ${moduleSpecifier} outside a declared transport seam`, node.getStart(source))
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      report('calls fetch outside a declared transport seam', node.getStart(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function hostFindings(file: CorpusFile, policy: PrivateDistributionPolicy): Finding[] {
  const recorded = new Set(policy.recordedHosts.map(({ host }) => host))
  const findings: Finding[] = []
  for (const match of file.text.matchAll(HOST)) {
    const host = (match[1] ?? '').toLowerCase()
    if (recorded.has(host)) continue
    const position = match.index
    const line = file.text.slice(0, position).split('\n').length
    findings.push({
      rule: 'egress',
      path: file.path,
      line,
      evidence: `host ${host}`,
      message: `reaches literal host ${host}, which the policy does not record`,
      hint: `record ${host} in scripts/private-distribution/policy.ts with what it identifies, or route the request through configuration`,
    })
  }
  return findings
}

/**
 * Find egress outside a declared transport seam and unrecorded literal hosts inside one.
 * @param files - audited corpus.
 * @param policy - removal policy the audit enforces.
 * @returns findings for undeclared egress and for literal hosts the policy does not record.
 */
export function scanEgress(files: readonly CorpusFile[], policy: PrivateDistributionPolicy): Finding[] {
  return files.flatMap((file) => {
    if (file.kind !== 'source') return []
    return seamFor(file.path, policy) === undefined ? egressFindings(file) : hostFindings(file, policy)
  })
}
