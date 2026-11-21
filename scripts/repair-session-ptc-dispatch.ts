/**
 * Repair stored Session logs whose PTC dispatch sub-call ids repeat.
 *
 * A provider may reuse one tool-call id across consecutive steps. Releases that
 * numbered sub-calls per program invocation then wrote the same sub-call id
 * twice, and the Session format reader refuses the whole log. This command
 * renumbers only the colliding ids of the later invocation, rewrites only the
 * recorded id fields, keeps every other value, and recompresses only the frames
 * that contain a changed row.
 *
 * The dry run only reads. Writing takes the Session's write claim first, so a
 * live writer cannot append between the read and the replacement, and the
 * original bytes are copied to a backup before the repaired file is published.
 *
 * Usage: `pnpm run repair:sessions-ptc [--sessions-dir PATH] [--apply] [--backup-dir PATH]`
 * @module
 */

import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionWriteLease } from '../packages/session/session-persistence-jsonl/src/lease.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

/** Stored Session log filenames this command inspects. */
const STORED_LOG_PATTERN = /^session\.v\d+\.jsonl\.zstd$/

/** Resolved command line. */
export interface RepairArguments {
  /** Session root holding project directories. */
  readonly sessionsDir: string
  /** Write repaired logs; false reports the renames and changes nothing. */
  readonly apply: boolean
  /** Root for the backups written before a repaired log replaces its original. */
  readonly backupRoot: string
}

/** One stored event row, keeping the complete envelope so a rewrite preserves it. */
interface StoredRow {
  readonly value: Record<string, unknown>
  readonly type: string
  readonly data: Record<string, unknown>
}

/** One decoded row line: its text and, for event rows, the parsed value. */
interface StoredLine {
  readonly line: string
  readonly row?: StoredRow
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
Session format reader accepts them again. The dry run writes nothing.

Options:
  --sessions-dir PATH  Session root to inspect (default: ~/.dsh/sessions)
  --apply              Write the repaired logs; without it the command is a dry run
  --backup-dir PATH    Where the original bytes are copied first
                       (default: ~/.dsh/session-repair-backups)
  --help               Show this help
`

/** Raised so the entry point can print help without treating it as a failure. */
export class HelpRequested extends Error {
  constructor() { super('help requested') }
}

/**
 * Resolve the command line.
 * @param argv - arguments after the script path.
 * @param home - Harness home used by the defaults, replaceable by tests.
 * @returns the resolved arguments.
 * @throws {HelpRequested} for `--help`.
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

/** Recorded id field one event type carries. */
type IdSlot =
  | { readonly where: 'data'; readonly key: string }
  | { readonly where: 'toolCall'; readonly key: 'callId' }
  | { readonly where: 'source'; readonly key: 'callId' }

/** Read one recursively owned object, or undefined. */
function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Every id one row records in a known slot. */
function slotValues(row: StoredRow): string[] {
  const values: string[] = []
  for (const slot of slotsFor(row.type)) {
    const owner = slot.where === 'data' ? row.data : objectAt(row.data[slot.where])
    const value = owner?.[slot.key]
    if (typeof value === 'string') values.push(value)
  }
  return values
}

/** Event types whose ids this command may rewrite. */
const DISPATCH_TYPES = new Set(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])

/** The answer a timed program question records when the user replies. */
const QUESTION_REPLY_TYPE = 'user/message'

/** The only id fields one event type records, so a rewrite cannot touch another meaning. */
function slotsFor(type: string): readonly IdSlot[] {
  if (DISPATCH_TYPES.has(type)) return [{ where: 'data', key: 'subCallId' }, { where: 'data', key: 'parentCallId' }]
  if (LATE_REFERENCE_TYPES.has(type)) return [{ where: 'toolCall', key: 'callId' }]
  // A user-question reply settles the dispatch its `source.callId` names.
  if (type === QUESTION_REPLY_TYPE) return [{ where: 'source', key: 'callId' }]
  return []
}

/** Rewrite this event type's own id slots; every envelope field and other value stay untouched. */
function rewriteSlots(row: StoredRow, renames: ReadonlyMap<string, string>): Record<string, unknown> {
  const mapped = (value: unknown): unknown => {
    const next = typeof value === 'string' ? renames.get(value) : undefined
    return next ?? value
  }
  const data: Record<string, unknown> = { ...row.data }
  for (const slot of slotsFor(row.type)) {
    if (slot.where === 'data') {
      data[slot.key] = mapped(data[slot.key])
      continue
    }
    const nested = objectAt(data[slot.where])
    if (nested !== undefined) data[slot.where] = { ...nested, [slot.key]: mapped(nested[slot.key]) }
  }
  return { ...row.value, data }
}

/** Parse one stored line; header rows keep their text and stay unparsed. */
function parseLine(line: string): StoredLine {
  const value: unknown = JSON.parse(line)
  const record = objectAt(value)
  const type = record?.['type']
  if (record === undefined || typeof type !== 'string') throw new Error('stored row without a type')
  const data = objectAt(record['data'])
  return data === undefined ? { line } : { line, row: { value: record, type, data } }
}

/** One program invocation: its `tool/call` row through the matching result. */
interface CallWindow {
  readonly callId: string
  readonly start: number
  readonly end: number
}

/** Pair every `tool/call` with the first later result that settles that call id. */
function callWindows(lines: readonly StoredLine[]): CallWindow[] {
  const windows: CallWindow[] = []
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row?.type !== 'tool/call') continue
    const callId = row.data['callId']
    if (typeof callId !== 'string') continue
    let end = lines.length - 1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]?.row
      if (candidate?.type !== 'tool/result') continue
      const source = objectAt(objectAt(candidate.data['message'])?.['source'])
      if (source?.['callId'] === callId) { end = cursor; break }
    }
    windows.push({ callId, start: index, end })
  }
  return windows
}

/** Choose an id that no recorded value uses. */
function freshId(candidate: string, used: ReadonlySet<string>): string {
  let attempt = 1
  let next = `${candidate}#${attempt}`
  while (used.has(next)) {
    attempt += 1
    next = `${candidate}#${attempt}`
  }
  return next
}

/** One planned rename and the invocation that owns it. */
interface PlannedRename {
  readonly from: string
  readonly to: string
  /** The program call whose rows this rename owns. */
  readonly callId: string
  /** Rows of that invocation. */
  readonly window: { readonly start: number; readonly end: number }
}

/**
 * Plan the renames one Session needs. A repeated program call id whose
 * invocation starts a sub-call id already recorded is the only collision this
 * command repairs; starts that cannot be attributed to a program invocation are
 * refused instead of guessed.
 * @param lines - stored rows in order.
 * @returns planned renames, in log order.
 * @throws Error when a repeated start cannot be attributed to an invocation.
 */
export function planRepairs(lines: readonly StoredLine[]): PlannedRename[] {
  const windows = callWindows(lines)
  const starts = lines
    .map((entry, index) => ({ index, row: entry.row }))
    .filter((entry): entry is { index: number; row: StoredRow } => entry.row?.type === 'tool/ptc-dispatch-start')
  const used = new Set<string>()
  for (const entry of lines) if (entry.row !== undefined) for (const value of slotValues(entry.row)) used.add(value)

  const plans: PlannedRename[] = []
  const firstWindowByCallId = new Map<string, number>()
  for (const [order, window] of windows.entries()) {
    const previous = firstWindowByCallId.get(window.callId)
    if (previous === undefined) { firstWindowByCallId.set(window.callId, order); continue }
    for (const entry of starts) {
      if (entry.index < window.start || entry.index > window.end) continue
      // A dispatch belongs to the invocation only when it records that call as
      // its root; an interleaved program's dispatch does not.
      if (entry.row.data['rootCallId'] !== window.callId) continue
      const subCallId = entry.row.data['subCallId']
      if (typeof subCallId !== 'string') continue
      const usedBefore = starts.some(other => other.index < window.start && other.row.data['subCallId'] === subCallId)
      if (!usedBefore) continue
      const to = freshId(subCallId, used)
      used.add(to)
      plans.push({ from: subCallId, to, callId: window.callId, window: { start: window.start, end: window.end } })
    }
  }
  // A start that repeats an id but belongs to no program invocation cannot be
  // repaired by attribution; refuse rather than guess.
  for (const entry of starts) {
    const subCallId = entry.row.data['subCallId']
    if (typeof subCallId !== 'string') continue
    const seenBefore = starts.some(other => other.index < entry.index && other.row.data['subCallId'] === subCallId)
    if (!seenBefore) continue
    const covering = plans.filter(plan => plan.from === subCallId
      && entry.index >= plan.window.start && entry.index <= plan.window.end)
    if (covering.length === 0) {
      throw new Error(`repeated sub-call ${subCallId} at row ${entry.index + 1} is outside the supported repair pattern`)
    }
  }
  return plans
}

/** Event types whose id fields may reference a sub-call after its invocation. */
const LATE_REFERENCE_TYPES = new Set(['job/registered', 'job/settled'])

/**
 * Which invocation one job belongs to, decided by its registration row. A job
 * registered by an invocation that the repair does not renumber stays unchanged;
 * one registered outside every invocation is refused when it names a sub-call
 * the repair renumbers, because its invocation cannot be proven.
 */
function jobOwners(
  lines: readonly StoredLine[],
  plans: readonly PlannedRename[],
  windows: readonly CallWindow[],
): Map<string, { readonly plan?: PlannedRename }> {
  const owners = new Map<string, { readonly plan?: PlannedRename }>()
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row?.type !== 'job/registered') continue
    const jobId = row.data['jobId']
    if (typeof jobId !== 'string') continue
    const reference = objectAt(row.data['toolCall'])?.['callId']
    const enclosing = windows.find(window => index >= window.start && index <= window.end)
    if (enclosing === undefined) {
      const claiming = typeof reference === 'string' ? plans.filter(plan => plan.from === reference) : []
      if (claiming.length > 0) {
        throw new Error(`job ${jobId} at row ${index + 1} is registered outside the invocations it names`)
      }
      continue
    }
    const plan = typeof reference === 'string'
      ? plans.find(candidate => candidate.from === reference && candidate.window.start === enclosing.start)
      : undefined
    owners.set(jobId, plan === undefined ? {} : { plan })
  }
  return owners
}

/** Build the per-row rename maps: an invocation's own dispatches, then its jobs. */
function rowRenames(lines: readonly StoredLine[], plans: readonly PlannedRename[]): Map<number, Map<string, string>> {
  const perRow = new Map<number, Map<string, string>>()
  const windows = callWindows(lines)
  const assign = (index: number, from: string, to: string): void => {
    const existing = perRow.get(index) ?? new Map<string, string>()
    const previous = existing.get(from)
    if (previous !== undefined && previous !== to) {
      throw new Error(`row ${index + 1} would take ${from} to two ids`)
    }
    existing.set(from, to)
    perRow.set(index, existing)
  }
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row === undefined || !DISPATCH_TYPES.has(row.type)) continue
    const window = windows.find(candidate => index >= candidate.start && index <= candidate.end)
    if (window === undefined || row.data['rootCallId'] !== window.callId) continue
    const values = slotValues(row)
    // Every rename this invocation applied to this row, so a nested child and
    // its parent each follow their own mapping.
    for (const plan of plans) {
      if (plan.window.start !== window.start || !values.includes(plan.from)) continue
      assign(index, plan.from, plan.to)
    }
  }
  // A timed program question settles by the sub-call id its reply names. The
  // reply may arrive long after the invocation, so ownership is proved by the
  // absence of an earlier pending question on the same id.
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row?.type !== QUESTION_REPLY_TYPE) continue
    const reference = objectAt(row.data['source'])?.['callId']
    if (typeof reference !== 'string') continue
    const plan = plans.find(candidate => candidate.from === reference)
    if (plan === undefined) continue
    const earlierQuestion = lines.some((candidate, position) => position < plan.window.start
      && candidate.row?.type === 'tool/ptc-dispatch-start'
      && candidate.row.data['subCallId'] === reference
      && candidate.row.data['name'] === 'ask_user_question')
    if (earlierQuestion) {
      throw new Error(`reply at row ${index + 1} could settle either question named ${reference}`)
    }
    assign(index, plan.from, plan.to)
  }
  const claimed = new Set(plans.map(plan => plan.from))
  // Any other record that names a renumbered sub-call — a queued copy of a
  // reply, a projection record, a deliverable — would silently point at the
  // wrong dispatch, so the command refuses instead of leaving it behind.
  const handled = (type: string): boolean => DISPATCH_TYPES.has(type) || LATE_REFERENCE_TYPES.has(type) || type === QUESTION_REPLY_TYPE
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row === undefined || handled(row.type)) continue
    const reference = referencedCallIds(row.data).find(value => claimed.has(value))
    if (reference !== undefined) {
      throw new Error(`row ${index + 1} names the renumbered sub-call ${reference} in a field this command does not rewrite`)
    }
  }
  const owners = jobOwners(lines, plans, windows)
  for (const [index, entry] of lines.entries()) {
    const row = entry.row
    if (row === undefined || !LATE_REFERENCE_TYPES.has(row.type)) continue
    const reference = objectAt(row.data['toolCall'])?.['callId']
    const jobId = row.data['jobId']
    if (typeof jobId !== 'string' || typeof reference !== 'string' || !claimed.has(reference)) continue
    const owner = owners.get(jobId)
    if (owner === undefined) {
      // The job names a renamed sub-call but no registration proves which
      // invocation created it; rewriting by position would corrupt the pairing.
      throw new Error(`job ${jobId} at row ${index + 1} has no registration that proves its invocation`)
    }
    if (owner.plan === undefined) continue
    assign(index, owner.plan.from, owner.plan.to)
  }
  return perRow
}

/** Every value recorded under a `callId` key anywhere in one row. */
function referencedCallIds(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) referencedCallIds(item, found); return found }
  if (typeof value !== 'object' || value === null) return found
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'callId' && typeof nested === 'string') found.push(nested)
    else referencedCallIds(nested, found)
  }
  return found
}

/** One decoded stored log: its rows and the frame that held each row. */
interface DecodedLog {
  readonly lines: StoredLine[]
  /** Frame index per row, parallel to `lines`. */
  readonly lineFrame: number[]
  readonly frames: { start: number; end: number }[]
}

/** Decode one stored log into rows while remembering which frame held each line. */
async function decodeFrames(bytes: Buffer): Promise<DecodedLog> {
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined) throw new Error('the stored log ends in an incomplete frame; repair the tail first')
  const lines: StoredLine[] = []
  const lineFrame: number[] = []
  for (const [frameIndex, frame] of scan.frames.entries()) {
    const text = (await decompressZstdFrame(bytes.subarray(frame.start, frame.end))).toString('utf8')
    const rows = text.split('\n')
    if (rows.at(-1) !== '') throw new Error(`frame ${frameIndex} does not end on a row boundary`)
    rows.pop()
    for (const line of rows) {
      lines.push(parseLine(line))
      lineFrame.push(frameIndex)
    }
  }
  return { lines, lineFrame, frames: scan.frames }
}

/** Rebuild the log, recompressing only frames that contain a changed line. */
async function encodeFrames(
  bytes: Buffer,
  frames: readonly { start: number; end: number }[],
  lines: readonly StoredLine[],
  lineFrame: readonly number[],
  rewritten: ReadonlyMap<number, string>,
): Promise<Buffer> {
  const counts = frames.map(() => 0)
  for (const frameIndex of lineFrame) counts[frameIndex] = (counts[frameIndex] ?? 0) + 1
  const pieces: Buffer[] = []
  let cursor = 0
  for (const [frameIndex, frame] of frames.entries()) {
    const count = counts[frameIndex] ?? 0
    let changed = false
    for (let index = cursor; index < cursor + count; index += 1) {
      if (rewritten.has(index)) { changed = true; break }
    }
    if (changed) {
      const rows: string[] = []
      for (let index = cursor; index < cursor + count; index += 1) {
        const line = rewritten.get(index) ?? lines[index]?.line
        if (line !== undefined) rows.push(line)
      }
      pieces.push(await compressZstdFrame(`${rows.join('\n')}\n`))
    } else {
      pieces.push(bytes.subarray(frame.start, frame.end))
    }
    cursor += count
  }
  return Buffer.concat(pieces)
}

/** Verify that only intended id fields changed and no start id repeats. */
function verifyRewrite(
  before: readonly StoredLine[],
  after: readonly StoredLine[],
  perRow: ReadonlyMap<number, ReadonlyMap<string, string>>,
): void {
  if (before.length !== after.length) throw new Error('the repaired log changed its row count')
  for (let index = 0; index < before.length; index += 1) {
    const original = before[index]
    const next = after[index]
    if (original === undefined || next === undefined) throw new Error(`row ${index + 1} disappeared`)
    const renames = perRow.get(index)
    if (renames === undefined) {
      if (next.line !== original.line) throw new Error(`row ${index + 1} changed unexpectedly`)
      continue
    }
    if (original.row === undefined || next.row === undefined) throw new Error(`row ${index + 1} changed its kind`)
    const expected = JSON.stringify(rewriteSlots(original.row, renames))
    if (next.line !== expected) throw new Error(`row ${index + 1} changed beyond its id fields`)
  }
  const starts = new Set<string>()
  for (const entry of after) {
    if (entry.row?.type !== 'tool/ptc-dispatch-start') continue
    const id = entry.row.data['subCallId']
    if (typeof id !== 'string') continue
    if (starts.has(id)) throw new Error(`the repaired log still repeats ${id}`)
    starts.add(id)
  }
  // A rewritten job reference must still name a dispatch the log records.
  for (const index of perRow.keys()) {
    const row = after[index]?.row
    if (row === undefined || !LATE_REFERENCE_TYPES.has(row.type)) continue
    const reference = objectAt(row.data['toolCall'])?.['callId']
    if (typeof reference === 'string' && !starts.has(reference)) {
      throw new Error(`the repaired log leaves job ${reference} without a dispatch`)
    }
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Publish the repaired bytes under the Session's write claim. */
async function publish(path: string, bytes: Buffer, repaired: Buffer, backupRoot: string): Promise<void> {
  const current = await readFile(path)
  if (!current.equals(bytes)) throw new Error('the stored log changed while it was being repaired; nothing was written')
  const backupDir = join(backupRoot, basename(dirname(path)), timestamp())
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await writeFile(join(backupDir, basename(path)), bytes)
  const staged = `${path}.repair`
  try {
    await writeFile(staged, repaired, { flag: 'wx' })
    const handle = await open(staged, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await rename(staged, path)
  } catch (error: unknown) {
    await rm(staged, { force: true })
    throw error
  }
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
  let outcome: SessionRepairOutcome = { path, status: 'failed', renames: [], reason: 'the Session was not processed' }
  let releaseFailure: string | undefined
  try {
    if (options.apply) {
      // The claim is taken before any read: a writer that appends and releases
      // between our read and our replacement would otherwise be overwritten.
      lease = await SessionWriteLease.acquire(sessionDir, sessionId)
    }
    const bytes = await readFile(path)
    const decoded = await decodeFrames(bytes)
    const plans = planRepairs(decoded.lines)
    const renames = plans.map(plan => ({ from: plan.from, to: plan.to }))
    if (plans.length === 0) {
      outcome = { path, status: 'clean', renames: [] }
    } else {
      // The same per-row plan validates every refusal in a dry run; only
      // encoding and publication are reserved for apply.
      const perRow = rowRenames(decoded.lines, plans)
      if (!options.apply) {
        outcome = { path, status: 'planned', renames }
      } else {
        const rewritten = new Map<number, string>()
        for (const [index, mapping] of perRow) {
          const row = decoded.lines[index]?.row
          if (row === undefined) continue
          rewritten.set(index, JSON.stringify(rewriteSlots(row, mapping)))
        }
        const repaired = await encodeFrames(bytes, decoded.frames, decoded.lines, decoded.lineFrame, rewritten)
        verifyRewrite(decoded.lines, (await decodeFrames(repaired)).lines, perRow)
        // Publication is the last step, so a rejection here means nothing was
        // replaced; the reason therefore always describes a file left untouched.
        await publish(path, bytes, repaired, options.backupRoot)
        outcome = { path, status: 'repaired', renames }
      }
    }
  } catch (error: unknown) {
    const refused = error instanceof Error && error.name === 'SessionAlreadyOwnedError'
    const message = error instanceof Error ? error.message : String(error)
    outcome = { path, status: refused ? 'refused' : 'failed', renames: [], reason: message }
  } finally {
    // Release whatever the path above did, including a clean or dry-run Session
    // that returned before any write.
    if (lease !== undefined) {
      try {
        await lease.release()
      } catch (error: unknown) {
        releaseFailure = error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (releaseFailure === undefined) return outcome
  // A replacement that already committed stays reported as such; the claim
  // failure is surfaced instead of aborting the rest of the corpus.
  const prefix = outcome.reason === undefined ? '' : `${outcome.reason}; `
  return { ...outcome, reason: `${prefix}the write claim could not be released: ${releaseFailure}` }
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
      // Stored Session directories are either `session-<id>` or the bare id.
      if (!session.isDirectory()) continue
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
  if (args.apply) {
    const report = join(tmpdir(), `dsh-repair-sessions-ptc-${Date.now()}.log`)
    await writeFile(report, outcomes.map(outcome => `${JSON.stringify(outcome)}\n`).join(''))
    process.stdout.write(`report: ${report}\n`)
  }
  process.stdout.write(
    `repair:sessions-ptc: ${counts.repaired} repaired, ${counts.planned} planned, ${counts.clean} clean, `
    + `${counts.refused} refused, ${counts.failed} failed${args.apply ? '' : ' (dry run)'}\n`,
  )
  if (counts.failed > 0) process.exit(1)
}
