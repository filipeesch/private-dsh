/** Confine network egress to declared transport seams and recorded literal hosts. */

import ts from 'typescript'
import type { CorpusFile } from '../corpus.ts'
import type { PrivateDistributionPolicy, TransportSeam } from '../policy.ts'
import type { Finding } from '../scan.ts'

/** Modules that open a socket, listen, or resolve a host, including their subpath entries. */
const NETWORK_MODULES = ['node:net', 'node:http', 'node:https', 'node:tls', 'node:dns', 'node:http2'] as const
/** Browser globals that reach the network without `fetch`. */
const NETWORK_GLOBALS = new Set(['WebSocket', 'EventSource', 'XMLHttpRequest'])

function isNetworkModule(specifier: string): boolean {
  return NETWORK_MODULES.some(name => specifier === name || specifier.startsWith(`${name}/`))
}

/** A call to the global `fetch`; a `.fetch` method on a service is that seam's own API. */
function isFetchCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'fetch'
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'fetch') return false
  const base = node.expression.expression.getText()
  return base === 'globalThis' || base === 'window' || base === 'self' || base === 'globalThis.window'
}

function isNetworkConstructor(node: ts.NewExpression, source: ts.SourceFile): boolean {
  const text = node.expression.getText(source)
  return NETWORK_GLOBALS.has(text) || text === 'globalThis.WebSocket'
}

function literalModuleSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier
    return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : undefined
  }
  if (!ts.isCallExpression(node)) return undefined
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
  const required = ts.isIdentifier(node.expression) && node.expression.text === 'require'
  const [argument] = node.arguments
  if ((dynamic || required) && argument !== undefined && ts.isStringLiteralLike(argument)) return argument.text
  return undefined
}
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
    const moduleSpecifier = literalModuleSpecifier(node)
    if (moduleSpecifier !== undefined && isNetworkModule(moduleSpecifier)) {
      report(`imports ${moduleSpecifier} outside a declared transport seam`, node.getStart(source))
    }
    if (ts.isCallExpression(node) && isFetchCall(node)) {
      report('calls fetch outside a declared transport seam', node.getStart(source))
    }
    if (ts.isNewExpression(node) && isNetworkConstructor(node, source)) {
      report('opens a network connection outside a declared transport seam', node.getStart(source))
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
