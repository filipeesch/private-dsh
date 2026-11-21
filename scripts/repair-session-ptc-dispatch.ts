/**
 * Repair stored Session logs whose PTC dispatch sub-call ids repeat.
 *
 * A provider may reuse one tool-call id across consecutive steps. Releases that
 * numbered sub-calls per program invocation then wrote the same sub-call id
 * twice, and the Session format reader refuses the whole log. This command
 * renumbers only the colliding ids of the later invocation, keeps every other
 * recorded value, and recompresses only the frames that contain a changed row.
 *
 * Usage: `pnpm run repair:sessions-ptc [--sessions-dir PATH] [--apply] [--backup-dir PATH]`
 *
 * The default is a dry run. A repaired Session is written beside a backup of
 * the original, and the command refuses a Session whose log ends in an
 * incomplete frame or whose write claim another live process holds.
 * @module
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionWriteLease } from '../packages/session/session-persistence-jsonl/src/lease.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

/** Resolved command line. */
export interface RepairArguments {
  /** Session root holding project directories. */
  readonly sessionsDir: string
  /** Write repaired logs; false reports the renames and changes nothing. */
  readonly apply: boolean
  /** Root for the backups written before a repaired log replaces its original. */
  readonly backupRoot: string
}

/** Stored Session log filenames this command inspects. */
const STORED_LOG_PATTERN = /^session\.v\d+\.jsonl\.zstd$/

/** One stored row of a Session log, with the ids it references. */
interface Row {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Outcome of one Session, reported in the summary. */
export interface SessionRepairOutcome {
  /** Stored log that this outcome describes. */
  readonly path: string
  /** `repaired` wrote a change, `planned` would write one, `clean` needed none, `refused` declined safely, `failed` errored. */
  readonly status: 'repaired' | 'planned' | 'clean' | 'refused' | 'failed'
  /** Id renames applied, or that would apply during a dry run. */
  readonly renames: readonly { readonly from: string; readonly to: string }[]
  /** Why a Session was refused or failed. */
  readonly reason?: string
}

const usage = `Usage: pnpm run repair:sessions-ptc [options]

Renumber colliding PTC dispatch sub-call ids in stored Session logs so the
Session format reader accepts them again.

Options:
  --sessions-dir PATH  Session root to inspect (default: ~/.dsh/sessions)
  --apply              Write the repaired logs; without it the command is a dry run
  --backup-dir PATH    Where repaired originals are copied first
                       (default: ~/.dsh/session-repair-backups)
  --help               Show this help
`

/**
 * Resolve the command line.
 * @param argv - arguments after the script path.
 * @param home - Harness home used by the defaults, replaceable by tests.
 * @returns the resolved arguments.
 * @throws Error when an option is unknown or lacks a value.
 */
export function parseRepairArguments(argv: readonly string[], home: string = resolveDshHome()): RepairArguments {
  let sessionsDir = join(home, 'sessions')
  let backupRoot = join(home, 'session-repair-backups')
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) break
    if (argument === '--apply') { apply = true; continue }
    if (argument === '--help' || argument === '-h') throw new HelpRequested()
    if (argument === '--sessions-dir' || argument === '--backup-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`repair:sessions-ptc: ${argument} needs a path`)
      index += 1
      if (argument === '--sessions-dir') sessionsDir = resolve(value)
      else backupRoot = resolve(value)
      continue
    }
    throw new Error(`repair:sessions-ptc: unknown argument "${argument}"`)
  }
  return { sessionsDir, apply, backupRoot }
}

/** Raised so the entry point can print help without treating it as a failure. */
export class HelpRequested extends Error {
  constructor() { super('help requested') }
}

/** Whether two rows carry the dispatch ids this repair renumbers. */
interface IdSlots {
  readonly subCallId?: string
  readonly parentCallId?: string
}

function idSlots(row: Row): IdSlots {
  const data = row.data
  return {
    ...typeof data['subCallId'] === 'string' ? { subCallId: data['subCallId'] } : {},
    ...typeof data['parentCallId'] === 'string' ? { parentCallId: data['parentCallId'] } : {},
  }
}

/** Every recorded id reference one row may carry, so renames follow dependent records. */
function referencedIds(row: Row): string[] {
  const slots = idSlots(row)
  const toolCall = row.data['toolCall']
  const ids = [slots.subCallId, slots.parentCallId]
  if (typeof toolCall === 'object' && toolCall !== null) {
    const callId = (toolCall as Record<string, unknown>)['callId']
    if (typeof callId === 'string') ids.push(callId)
  }
  const direct = row.data['callId']
  if (typeof direct === 'string') ids.push(direct)
  return ids.filter((id): id is string => id !== undefined)
}

/** One program invocation's rows: its `tool/call` through the matching result. */
interface CallWindow {
  readonly callId: string
  readonly start: number
  readonly end: number
}

function callWindows(rows: readonly Row[]): CallWindow[] {
  const windows: CallWindow[] = []
  for (const [index, row] of rows.entries()) {
    if (row.type !== 'tool/call') continue
    const callId = row.data['callId']
    if (typeof callId !== 'string') continue
    let end = rows.length - 1
    for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
      const next = rows[cursor]
      if (next === undefined) break
      if (next.type === 'tool/call') { end = cursor - 1; break }
      const message = next.data['message'] as Record<string, unknown> | undefined
      const source = message?.['source'] as Record<string, unknown> | undefined
      if (next.type === 'tool/result' && source?.['callId'] === callId) { end = cursor; break }
    }
    windows.push({ callId, start: index, end })
  }
  return windows
}

/**
 * Plan the renames one Session needs.
 * @param rows - stored rows in order.
 * @returns per-row replacement maps, empty when nothing collides.
 */
export function planRepairs(rows: readonly Row[]): Map<number, Map<string, string>> {
  const used = new Set<string>()
  for (const row of rows) for (const id of referencedIds(row)) used.add(id)

  const plan = new Map<number, Map<string, string>>()
  const seenCallIds = new Set<string>()
  for (const window of callWindows(rows)) {
    const repeated = seenCallIds.has(window.callId)
    seenCallIds.add(window.callId)
    if (!repeated) continue
    const mapping = new Map<string, string>()
    for (let index = window.start; index <= window.end; index += 1) {
      const row = rows[index]
      if (row === undefined) continue
      const { subCallId } = idSlots(row)
      // Only ids this invocation starts are renumbered: a parent id that points
      // outside the window belongs to an earlier, already admitted dispatch.
      if (row.type !== 'tool/ptc-dispatch-start' || subCallId === undefined) continue
      if (mapping.has(subCallId)) continue
      if (!usedLater(rows, index, subCallId)) continue
      let attempt = 1
      let candidate = `${subCallId}#${attempt}`
      while (used.has(candidate)) {
        attempt += 1
        candidate = `${subCallId}#${attempt}`
      }
      used.add(candidate)
      mapping.set(subCallId, candidate)
    }
    if (mapping.size === 0) continue
    for (let index = window.start; index <= window.end; index += 1) {
      const row = rows[index]
      if (row === undefined) continue
      const hits = referencedIds(row).filter(id => mapping.has(id))
      if (hits.length === 0) continue
      const perRow = new Map<string, string>()
      for (const hit of hits) {
        const replacement = mapping.get(hit)
        if (replacement !== undefined) perRow.set(hit, replacement)
      }
      plan.set(index, perRow)
    }
  }
  return plan
}

/** Whether an id was recorded before `before`, which is what makes it a collision. */
function usedLater(rows: readonly Row[], before: number, id: string): boolean {
  for (let index = 0; index < before; index += 1) {
    const row = rows[index]
    if (row !== undefined && referencedIds(row).includes(id)) return true
  }
  return false
}

/** Replace recorded ids in one row, keeping every other byte of the row intact. */
function rewriteRow(line: string, replacements: Map<string, string>): string {
  let next = line
  for (const [from, to] of replacements) {
    const quoted = JSON.stringify(from)
    if (!next.includes(quoted)) throw new Error(`row does not contain ${quoted}`)
    next = next.split(quoted).join(JSON.stringify(to))
  }
  return next
}

/** Decode one stored log into rows while remembering which frame held each row. */
async function decodeFrames(bytes: Buffer): Promise<{ rows: string[]; rowFrame: number[]; frames: { start: number; end: number }[] }> {
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined) throw new Error('the stored log ends in an incomplete frame; repair the tail first')
  const rows: string[] = []
  const rowFrame: number[] = []
  for (const [frameIndex, frame] of scan.frames.entries()) {
    const text = (await decompressZstdFrame(bytes.subarray(frame.start, frame.end))).toString('utf8')
    const lines = text.split('\n')
    if (lines.at(-1) !== '') throw new Error(`frame ${frameIndex} does not end on a row boundary`)
    lines.pop()
    for (const line of lines) {
      rows.push(line)
      rowFrame.push(frameIndex)
    }
  }
  return { rows, rowFrame, frames: scan.frames }
}

/** Rebuild the log, recompressing only frames that contain a changed row. */
async function encodeFrames(
  bytes: Buffer,
  frames: readonly { start: number; end: number }[],
  rows: readonly string[],
  rowFrame: readonly number[],
  rewritten: ReadonlyMap<number, string>,
): Promise<Buffer> {
  const counts = frames.map(() => 0)
  for (const frameIndex of rowFrame) counts[frameIndex] = (counts[frameIndex] ?? 0) + 1
  const pieces: Buffer[] = []
  let cursor = 0
  for (const [frameIndex, frame] of frames.entries()) {
    const count = counts[frameIndex] ?? 0
    let changed = false
    for (let index = cursor; index < cursor + count; index += 1) {
      if (rewritten.has(index)) { changed = true; break }
    }
    if (changed) {
      const lines: string[] = []
      for (let index = cursor; index < cursor + count; index += 1) {
        const line = rewritten.get(index) ?? rows[index]
        if (line !== undefined) lines.push(line)
      }
      pieces.push(await compressZstdFrame(`${lines.join('\n')}\n`))
    } else {
      pieces.push(bytes.subarray(frame.start, frame.end))
    }
    cursor += count
  }
  return Buffer.concat(pieces)
}

/**
 * Repair one stored Session log.
 * @param path - the stored log to inspect.
 * @param options - whether to write, and where backups go.
 * @returns the outcome for the summary.
 */
export async function repairSessionLog(
  path: string,
  options: { readonly apply: boolean; readonly backupRoot: string },
): Promise<SessionRepairOutcome> {
  const sessionDir = dirname(path)
  const sessionId = brandString<SessionId>(basename(sessionDir).replace(/^session-/, ''))
  let lease: SessionWriteLease | undefined
  try {
    const bytes = await readFile(path)
    const decoded = await decodeFrames(bytes)
    const rows = decoded.rows.map((line, index) => {
      try {
        return JSON.parse(line) as Row
      } catch (error: unknown) {
        throw new Error(`row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    const plan = planRepairs(rows)
    const renames = [...new Map([...plan.values()].flatMap(perRow => [...perRow])).entries()]
      .map(([from, to]) => ({ from, to }))
    if (renames.length === 0) return { path, status: 'clean', renames: [] }

    if (!options.apply) return { path, status: 'planned', renames }

    lease = await SessionWriteLease.acquire(sessionDir, sessionId)
    const rewritten = new Map<number, string>()
    for (const [index, replacements] of plan) {
      const original = decoded.rows[index]
      if (original === undefined) throw new Error(`row ${index + 1} is missing from the stored log`)
      const line = rewriteRow(original, replacements)
      JSON.parse(line)
      rewritten.set(index, line)
    }
    const repaired = await encodeFrames(bytes, decoded.frames, decoded.rows, decoded.rowFrame, rewritten)

    // Self-verification: same rows, intended changes only, valid frames, no repeats.
    const verified = await decodeFrames(repaired)
    if (verified.rows.length !== decoded.rows.length) throw new Error('the repaired log changed its row count')
    const starts = new Set<string>()
    for (const [index, line] of verified.rows.entries()) {
      const row = JSON.parse(line) as Row
      if (row.type !== 'tool/ptc-dispatch-start') continue
      const id = idSlots(row).subCallId
      if (id === undefined) continue
      if (starts.has(id)) throw new Error(`the repaired log still repeats ${id} at row ${index + 1}`)
      starts.add(id)
      if (line !== decoded.rows[index] && !rewritten.has(index)) throw new Error(`row ${index + 1} changed unexpectedly`)
    }

    const backupDir = join(options.backupRoot, basename(sessionDir), timestamp())
    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    await copyFile(path, join(backupDir, basename(path)))
    const staged = `${path}.repair`
    try {
      await writeFile(staged, repaired)
      await rename(staged, path)
    } catch (error: unknown) {
      await rm(staged, { force: true })
      throw error
    }
    return { path, status: 'repaired', renames }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const refused = error instanceof Error && error.name === 'SessionAlreadyOwnedError'
    return { path, status: refused ? 'refused' : 'failed', renames: [], reason: message }
  } finally {
    await lease?.release()
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Discover every stored Session log under a Session root.
 * @param sessionsDir - root holding one directory per project.
 * @returns stored log paths in stable order.
 */
export async function discoverSessionLogs(sessionsDir: string): Promise<string[]> {
  const found: string[] = []
  for (const project of await readdir(sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsDir, project.name)
    for (const session of await readdir(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      const sessionDir = join(projectDir, session.name)
      for (const file of await readdir(sessionDir, { withFileTypes: true })) {
        if (file.isFile() && STORED_LOG_PATTERN.test(file.name)) found.push(join(sessionDir, file.name))
      }
    }
  }
  return found.sort()
}

/**
 * Repair every stored Session under the resolved root.
 * @param args - resolved command line.
 * @returns one outcome per Session, in discovery order.
 */
export async function repairSessions(args: RepairArguments): Promise<SessionRepairOutcome[]> {
  const logs = await discoverSessionLogs(args.sessionsDir)
  const outcomes: SessionRepairOutcome[] = []
  for (const path of logs) {
    outcomes.push(await repairSessionLog(path, { apply: args.apply, backupRoot: args.backupRoot }))
  }
  return outcomes
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  let args: RepairArguments
  try {
    args = parseRepairArguments(process.argv.slice(2))
  } catch (error: unknown) {
    if (error instanceof HelpRequested) {
      process.stdout.write(usage)
      process.exit(0)
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write(usage)
    process.exit(2)
  }
  const outcomes = await repairSessions(args)
  const counts = { repaired: 0, planned: 0, clean: 0, refused: 0, failed: 0 }
  for (const outcome of outcomes) {
    counts[outcome.status] += 1
    process.stdout.write(`${outcome.status}: ${outcome.path}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}\n`)
    for (const rename of outcome.renames) process.stdout.write(`  ${rename.from} -> ${rename.to}\n`)
  }
  const report = join(tmpdir(), `dsh-repair-sessions-ptc-${Date.now()}.log`)
  await writeFile(report, outcomes.map(outcome => `${JSON.stringify(outcome)}\n`).join(''))
  process.stdout.write(
    `repair:sessions-ptc: ${counts.repaired} repaired, ${counts.planned} planned, ${counts.clean} clean, `
    + `${counts.refused} refused, ${counts.failed} failed${args.apply ? '' : ' (dry run)'}\n`
    + `report: ${report}\n`,
  )
  if (counts.failed > 0) process.exit(1)
}
