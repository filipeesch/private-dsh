import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionWriteLease } from '../packages/session/session-persistence-jsonl/src/lease.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  discoverSessionLogs,
  parseRepairArguments,
  planRepairs,
  repairSessionLog,
  repairSessions,
  HelpRequested,
} from './repair-session-ptc-dispatch.ts'

type Row = Record<string, unknown> & { type: string; data: Record<string, unknown> }
const stepOne = { turn: 1, step: 1 }
const stepTwo = { turn: 1, step: 2 }

function starter(overrides: Record<string, unknown> = {}): Row {
  return {
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'call-x', parentCallId: 'call-x', subCallId: 'call-x:ptc:1', name: 'read', arguments: {}, ...overrides },
  }
}

function settle(overrides: Record<string, unknown> = {}): Row {
  return {
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'call-x', parentCallId: 'call-x', subCallId: 'call-x:ptc:1', name: 'read', arguments: {},
      isError: false, content: [], ...overrides,
    },
  }
}

/** A log where the provider reused one tool-call id in two consecutive steps. */
function collidingRows(): Row[] {
  const { turn, step } = stepOne
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: stepOne },
    { type: 'tool/call', data: { turn, step, callId: 'call-x', name: 'run_code', arguments: '{}' } },
    starter(),
    settle(),
    { type: 'job/registered', data: { jobId: 'job-1', toolCall: { callId: 'call-x:ptc:1', rootCallId: 'call-x' } } },
    { type: 'tool/result', data: { turn, step, message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'call-x' }, toolCallId: 'call-x', content: [] } } },
    { type: 'step/end', data: stepOne },
    { type: 'step/start', data: stepTwo },
    { type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-x', name: 'run_code', arguments: '{}' } },
    starter(),
    settle(),
    // A nested program dispatched by the repeated invocation: its ids follow the parent.
    starter({ parentCallId: 'call-x:ptc:1', subCallId: 'call-x:ptc:1:ptc:1', name: 'nested' }),
    settle({ parentCallId: 'call-x:ptc:1', subCallId: 'call-x:ptc:1:ptc:1', name: 'nested' }),
    { type: 'job/registered', data: { jobId: 'job-2', toolCall: { callId: 'call-x:ptc:1', rootCallId: 'call-x' } } },
    { type: 'tool/result', data: { turn: 1, step: 2, message: { id: 'r2', role: 'tool', source: { kind: 'tool', callId: 'call-x' }, toolCallId: 'call-x', content: [] } } },
    { type: 'step/end', data: stepTwo },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Bump the dispatch-id ordinal, the way a provider-unique log would look. */
const bump = (value: unknown): unknown => typeof value === 'string' ? value.replace('ptc:1', 'ptc:2') : value

/** A log whose provider ids are unique. */
function cleanRows(): Row[] {
  return collidingRows().map((row, index) => {
    if (typeof row.data['subCallId'] !== 'string') return row
    if (index < 10) return row
    return {
      ...row,
      data: {
        ...row.data,
        subCallId: bump(row.data['subCallId']),
        ...typeof row.data['parentCallId'] === 'string' ? { parentCallId: bump(row.data['parentCallId']) } : {},
      },
    }
  })
}

async function encodeLog(rows: readonly Row[], rowsPerFrame = 3): Promise<Buffer> {
  const frames: Buffer[] = []
  for (let index = 0; index < rows.length; index += rowsPerFrame) {
    const slice = rows.slice(index, index + rowsPerFrame).map(row => JSON.stringify(row) + '\n').join('')
    frames.push(await compressZstdFrame(slice))
  }
  return Buffer.concat(frames)
}

async function storedLog(root: string, rows: readonly Row[], name = 'session.v4.jsonl.zstd'): Promise<string> {
  const sessionDir = join(root, 'project', 'session-11111111-1111-4111-8111-111111111111')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, name)
  await writeFile(path, await encodeLog(rows))
  return path
}

async function decodedRows(path: string): Promise<Row[]> {
  const bytes = await readFile(path)
  const scan = scanZstdFrames(bytes)
  const rows: Row[] = []
  for (const frame of scan.frames) {
    const text = (await decompressZstdFrame(bytes.subarray(frame.start, frame.end))).toString('utf8')
    for (const line of text.split('\n')) if (line !== '') rows.push(JSON.parse(line) as Row)
  }
  return rows
}

const roots: string[] = []
async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-repair-ptc-'))
  roots.push(created)
  return created
}

afterEach(async () => {
  for (const created of roots.splice(0)) await rm(created, { recursive: true, force: true })
})

describe('repair argument parsing', () => {
  it('defaults to a dry run under the harness home', () => {
    expect(parseRepairArguments([], '/home/dsh')).toEqual({
      sessionsDir: '/home/dsh/sessions',
      apply: false,
      backupRoot: '/home/dsh/session-repair-backups',
    })
    expect(parseRepairArguments(['--apply', '--sessions-dir', '/logs', '--backup-dir', '/backups'], '/home/dsh')).toEqual({
      sessionsDir: '/logs',
      apply: true,
      backupRoot: '/backups',
    })
  })

  it('rejects unknown options and missing values', () => {
    expect(() => parseRepairArguments(['--nope'])).toThrow(/unknown argument/)
    expect(() => parseRepairArguments(['--sessions-dir'])).toThrow(/needs a path/)
    expect(() => parseRepairArguments(['--sessions-dir', '--apply'])).toThrow(/needs a path/)
    expect(() => parseRepairArguments(['--help'])).toThrow(HelpRequested)
  })
})

describe('repair planning', () => {
  it('renumbers only the later invocation and follows nested children', () => {
    const rows = collidingRows()
    const plan = planRepairs(rows)
    const replacements = [...plan.values()].flatMap(perRow => [...perRow])

    // Only the repeating id needs a fresh value; the nested child's own id is
    // already unique, so only its parent reference follows the rename.
    expect(new Map(replacements.map(([from, to]) => [from, to]))).toEqual(
      new Map([['call-x:ptc:1', 'call-x:ptc:1#1']]),
    )

    const cleaned = rows.map((row, index) => {
      const perRow = plan.get(index)
      if (perRow === undefined) return row
      const data = { ...row.data }
      for (const [from, to] of perRow) {
        if (data['subCallId'] === from) data['subCallId'] = to
        if (data['parentCallId'] === from) data['parentCallId'] = to
      }
      return { ...row, data }
    })
    const starts = cleaned
      .filter(row => row.type === 'tool/ptc-dispatch-start')
      .map(row => row.data['subCallId'])
    expect(new Set(starts).size).toBe(starts.length)
    expect(starts).toEqual(['call-x:ptc:1', 'call-x:ptc:1#1', 'call-x:ptc:1:ptc:1'])
  })

  it('plans nothing for unique ids or for a repeated call id alone', () => {
    expect(planRepairs(cleanRows()).size).toBe(0)
    const distinct = collidingRows().map((row, index) => index >= 9 && typeof row.data['subCallId'] === 'string'
      ? {
        ...row,
        data: {
          ...row.data,
          subCallId: bump(row.data['subCallId']),
          ...typeof row.data['parentCallId'] === 'string' ? { parentCallId: bump(row.data['parentCallId']) } : {},
        },
      }
      : row)
    expect(planRepairs(distinct).size).toBe(0)
  })
})

describe('stored Session repair', () => {
  it('reports planned renames in a dry run and leaves the bytes untouched', async () => {
    const sessions = await root()
    const path = await storedLog(sessions, collidingRows())
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: false, backupRoot: join(sessions, 'backups') })

    expect(outcome.status).toBe('planned')
    expect(outcome.renames).toEqual([{ from: 'call-x:ptc:1', to: 'call-x:ptc:1#1' }])
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(sessions)).toEqual(['project'])
  })

  it('rewrites the colliding ids, keeps everything else, and backs up the original', async () => {
    const sessions = await root()
    const path = await storedLog(sessions, collidingRows())
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect([outcome.status, outcome.reason]).toEqual(['repaired', undefined])
    const after = await decodedRows(path)
    const original = await decodedRows(await storedLog(await root(), collidingRows()))
    expect(after).toHaveLength(original.length)
    const changedRows = after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(original[index]))
    expect(changedRows.map(row => row.type)).toEqual([
      'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'job/registered',
    ])
    const starts = after.filter(row => row.type === 'tool/ptc-dispatch-start').map(row => row.data['subCallId'])
    expect(starts).toEqual(['call-x:ptc:1', 'call-x:ptc:1#1', 'call-x:ptc:1:ptc:1'])
    const nested = after.filter(row => row.data['name'] === 'nested').map(row => row.data['parentCallId'])
    expect(nested).toEqual(['call-x:ptc:1#1', 'call-x:ptc:1#1'])

    const sessionBackups = await readdir(join(sessions, 'backups'))
    expect(sessionBackups).toEqual(['session-11111111-1111-4111-8111-111111111111'])
    const stamped = await readdir(join(sessions, 'backups', sessionBackups[0]!))
    expect(stamped).toHaveLength(1)
    const backupFile = join(sessions, 'backups', sessionBackups[0]!, stamped[0]!, 'session.v4.jsonl.zstd')
    expect(await readFile(backupFile)).toEqual(before)
  })

  it('leaves a clean Session alone', async () => {
    const sessions = await root()
    const path = await storedLog(sessions, cleanRows())
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcome).toEqual({ path, status: 'clean', renames: [] })
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(sessions)).toEqual(['project'])
  })

  it('refuses a log with an incomplete final frame', async () => {
    const sessions = await root()
    const path = await storedLog(sessions, collidingRows())
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]))
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('incomplete frame')
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses a Session whose write claim a live holder keeps', async () => {
    const sessions = await root()
    const path = await storedLog(sessions, collidingRows())
    const lease = await SessionWriteLease.acquire(join(sessions, 'project', 'session-11111111-1111-4111-8111-111111111111'), brandString<SessionId>('held'))
    try {
      const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })
      expect(outcome.status).toBe('refused')
      expect(outcome.reason).toContain('owned')
    } finally {
      await lease.release()
    }
  })

  it('discovers stored logs and keeps going after a failure', async () => {
    const sessions = await root()
    const healthy = await storedLog(sessions, collidingRows())
    const torn = await storedLog(sessions, collidingRows(), 'session.v3.jsonl.zstd')
    await writeFile(torn, Buffer.concat([await readFile(torn), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]))

    expect(await discoverSessionLogs(sessions)).toEqual([torn, healthy].sort())
    const outcomes = await repairSessions({ sessionsDir: sessions, apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcomes.map(outcome => [outcome.path, outcome.status])).toEqual([
      [torn, 'failed'],
      [healthy, 'repaired'],
    ])
  })
})
