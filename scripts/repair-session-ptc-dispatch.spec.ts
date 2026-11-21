import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionWriteLease } from '../packages/session/session-persistence-jsonl/src/lease.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import {
  discoverSessionLogs,
  parseRepairArguments,
  planRepairs,
  repairSessionLog,
  repairSessions,
  HelpRequested,
  type SessionRepairOutcome,
} from './repair-session-ptc-dispatch.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-ptc-'))
  roots.push(root)
  return root
}

const callId = 'call-x'

/** Valid V4 events for two consecutive program invocations that reuse one call id. */
function collidingEvents(): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  const append = (type: SessionEvent['type'], data: Record<string, unknown>, surface = false): void => {
    const envelope = surface ? { surfaceOp: 'append' as const } : {}
    events.push({ type, seq: SessionSeq(seq), time: seq + 1, data, ...envelope } as SessionEvent)
    seq += 1
  }
  const dispatch = (id: string, parent = callId, name = 'read'): void => {
    append('tool/ptc-dispatch-start', { rootCallId: callId, parentCallId: parent, subCallId: id, name, arguments: { path: id } })
    append('tool/ptc-dispatch', {
      rootCallId: callId, parentCallId: parent, subCallId: id, name, arguments: { path: id }, isError: false,
      content: [{ type: 'text', text: id }],
    })
  }
  append('turn/start', { turn: 1 })
  append('user/message', { id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run' }] }, true)
  append('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } })
  for (const step of [1, 2]) {
    append('step/start', { turn: 1, step })
    append('assistant/message', {
      turn: 1, step, stream: [],
      message: {
        id: `assistant-${step}`, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: '{"code":"x"}' }],
      },
    }, true)
    append('tool/call', { turn: 1, step, callId, name: 'run_code', arguments: '{"code":"x"}' })
    dispatch('call-x:ptc:1')
    dispatch('call-x:ptc:2')
    if (step === 2) {
      // A nested program dispatched by the repeated invocation.
      dispatch('call-x:ptc:1:ptc:1', 'call-x:ptc:1', 'nested')
      append('job/registered', { jobId: 'job-2', toolCall: { callId: 'call-x:ptc:1', rootCallId: callId } })
    } else {
      // A job registered by the invocation the repair leaves unchanged.
      append('job/registered', { jobId: 'job-first', toolCall: { callId: 'call-x:ptc:1', rootCallId: callId } })
    }
    append('tool/result', {
      turn: 1, step,
      message: { id: `result-${step}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [] },
    }, true)
    append('step/end', { turn: 1, step })
  }
  // Both jobs settle after their invocations; each must follow the invocation
  // that registered its jobId, not the position it settles in.
  append('job/settled', { jobId: 'job-first', status: 'completed', toolCall: { callId: 'call-x:ptc:1', rootCallId: callId } })
  append('job/settled', { jobId: 'job-2', status: 'completed', toolCall: { callId: 'call-x:ptc:1', rootCallId: callId } })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return events
}

/** Write a genuine compressed Session artifact through the persistence backend. */
async function realLog(sessions: string, events: readonly SessionEvent[]): Promise<string> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'zstd' })
  const id = brandString<SessionId>('11111111-1111-4111-8111-111111111111')
  const header: SessionHeader = {
    version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/workspace',
  }
  const write = await ctx.sessionPersistence.create(header)
  await write.append(events)
  await write.close()
  const found = await discoverSessionLogs(sessions)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** Decode every row of a stored log without the repair helper. */
async function decodeAll(path: string): Promise<Record<string, unknown>[]> {
  const bytes = await readFile(path)
  const scan = scanZstdFrames(bytes)
  const rows: Record<string, unknown>[] = []
  for (const frame of scan.frames) {
    const text = (await decompressZstdFrame(bytes.subarray(frame.start, frame.end))).toString('utf8')
    for (const line of text.split('\n')) if (line !== '') rows.push(JSON.parse(line) as Record<string, unknown>)
  }
  return rows
}

/** Turn typed events into the plain rows the planner reads, as JSON does. */
function rowsOf(events: readonly SessionEvent[]): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(events)) as Record<string, unknown>[]
}

/** Build one typed event from a plain row, as the log decoder would. */
function eventOf(row: Record<string, unknown>): SessionEvent {
  return JSON.parse(JSON.stringify(row)) as SessionEvent
}

/** The plain data object of one typed event, as JSON sees it. */
function dataOf(event: SessionEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event.data)) as Record<string, unknown>
}

/** Blank every recorded id so two rows can be compared for non-id equality. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    out[key] = key === 'subCallId' || key === 'parentCallId' || key === 'callId' ? '*' : withoutIds(nested)
  }
  return out
}

/** Mark the repeated invocation's `call-x:ptc:2` dispatch as a timed question and answer it. */
function answeredQuestion(events: readonly SessionEvent[], everyOccurrence: boolean): SessionEvent[] {
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(entry => entry.event.type === 'tool/ptc-dispatch-start'
      && dataOf(entry.event)['subCallId'] === 'call-x:ptc:2')
  const marked = everyOccurrence ? starts : starts.slice(-1)
  const asked = events.map((event, index) => marked.some(start => start.index === index)
    ? eventOf({ ...event, data: { ...dataOf(event), name: 'ask_user_question' } })
    : event)
  asked.push(eventOf({
    type: 'user/message', seq: asked.length, time: asked.length + 1, surfaceOp: 'append',
    data: { id: 'reply', role: 'user', source: { kind: 'user-question-reply', callId: 'call-x:ptc:2' }, content: [] },
  }))
  return asked.map((event, index) => ({ ...event, seq: SessionSeq(index), time: index + 1 }))
}

/** Queue the reply through the agent inbox, as the application does. */
function withQueuedReply(events: readonly SessionEvent[]): SessionEvent[] {
  const queued = [...events]
  queued.push(eventOf({
    type: 'agent/inbox/spliced', seq: queued.length, time: queued.length + 1,
    data: {
      target: 'next-turn', start: 0,
      inserted: [{
        id: 'reply', role: 'user',
        source: { kind: 'user-question-reply', callId: 'call-x:ptc:2' },
        content: [{ type: 'text', text: 'yes' }],
      }],
    },
  }))
  return queued.map((event, index) => ({ ...event, seq: SessionSeq(index), time: index + 1 }))
}

/** The recorded reply source that settles a timed program question. */
function questionReply(rows: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const row of rows) {
    const source = (row['data'] as Record<string, unknown> | undefined)?.['source']
    if (typeof source === 'object' && source !== null && (source as Record<string, unknown>)['kind'] === 'user-question-reply') {
      return source as Record<string, unknown>
    }
  }
  return undefined
}

const sessionDirOf = (path: string): string => join(path.split('/session.v')[0]!)

describe('repair argument parsing', () => {
  it('defaults to a dry run under the harness home', () => {
    expect(parseRepairArguments([], '/home/dsh')).toEqual({
      sessionsDir: '/home/dsh/sessions',
      apply: false,
      backupRoot: '/home/dsh/session-repair-backups',
    })
    expect(parseRepairArguments(['--apply', '--sessions-dir', '/logs', '--backup-dir', '/backups'], '/home/dsh')).toEqual({
      sessionsDir: '/logs', apply: true, backupRoot: '/backups',
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
  const lines = (rows: readonly Record<string, unknown>[], header: Record<string, unknown> | undefined = { type: 'session', version: 4 }) =>
    (header === undefined ? rows : [header, ...rows]).map(row => ({
      line: JSON.stringify(row),
      ...row['data'] === undefined ? {} : {
        row: { value: row, type: String(row['type']), data: row['data'] as Record<string, unknown> },
      },
    }))

  it('renumbers only the later invocation and attributes nested children', () => {
    const plans = planRepairs(lines(rowsOf(collidingEvents())))
    expect(plans.map(plan => [plan.from, plan.to])).toEqual([
      ['call-x:ptc:1', 'call-x:ptc:1#1'],
      ['call-x:ptc:2', 'call-x:ptc:2#1'],
    ])
  })

  it('plans nothing when the ids are unique or only the call id repeats', () => {
    const unique = rowsOf(collidingEvents())
    const secondInvocation = unique.findIndex((row, index) => row['type'] === 'tool/call'
      && unique.findIndex(candidate => candidate['type'] === 'tool/call') < index)
    for (const [index, row] of unique.entries()) {
      if (index < secondInvocation) continue
      const data = row['data']
      if (typeof data !== 'object' || data === null) continue
      const record = data as Record<string, unknown>
      if (typeof record['subCallId'] === 'string') record['subCallId'] = `${record['subCallId']}-second`
      if (typeof record['parentCallId'] === 'string') record['parentCallId'] = `${record['parentCallId']}-second`
    }
    expect(planRepairs(lines(unique))).toEqual([])
  })

  it('refuses a repeated start that no program invocation encloses', () => {
    const rows = collidingEvents().filter(event => event.type !== 'tool/call' && event.type !== 'tool/result')
    expect(() => planRepairs(lines(rowsOf(rows)))).toThrow(/outside the supported repair pattern/)
  })
})

describe('stored Session repair', () => {
  it('repairs a genuine compressed log, preserves the header, and backs up the original bytes', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents())
    const before = await readFile(path)
    const originalRows = await decodeAll(path)
    expect(originalRows[0]?.['type']).toBe('session')

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcome.status).toBe('repaired')
    expect(outcome.renames).toEqual([
      { from: 'call-x:ptc:1', to: 'call-x:ptc:1#1' },
      { from: 'call-x:ptc:2', to: 'call-x:ptc:2#1' },
    ])
    const after = await decodeAll(path)
    expect(after[0]?.['type']).toBe('session')
    expect(after).toHaveLength(originalRows.length)
    const starts = after
      .filter(row => row['type'] === 'tool/ptc-dispatch-start')
      .map(row => (row['data'] as Record<string, unknown>)['subCallId'])
    expect(starts).toEqual([
      'call-x:ptc:1', 'call-x:ptc:2',
      'call-x:ptc:1#1', 'call-x:ptc:2#1', 'call-x:ptc:1:ptc:1',
    ])
    const nestedParents = after
      .filter(row => (row['data'] as Record<string, unknown>)?.['name'] === 'nested')
      .map(row => (row['data'] as Record<string, unknown>)['parentCallId'])
    expect(nestedParents).toEqual(['call-x:ptc:1#1', 'call-x:ptc:1#1'])
    // The untouched invocation's job keeps its id; the repeated one follows it.
    const jobs = after
      .filter(row => String(row['type']).startsWith('job/'))
      .map(row => (row['data'] as Record<string, unknown>)['toolCall'])
    expect(jobs).toEqual([
      { callId: 'call-x:ptc:1', rootCallId: callId },
      { callId: 'call-x:ptc:1#1', rootCallId: callId },
      { callId: 'call-x:ptc:1', rootCallId: callId },
      { callId: 'call-x:ptc:1#1', rootCallId: callId },
    ])
    // Every row keeps all of its non-id content.
    expect(after.map(withoutIds)).toEqual(originalRows.map(withoutIds))

    const backups = await readdir(join(sessions, 'backups'))
    expect(backups).toEqual(['11111111-1111-4111-8111-111111111111'])
    const stamped = await readdir(join(sessions, 'backups', backups[0]!))
    expect(await readFile(join(sessions, 'backups', backups[0]!, stamped[0]!, 'session.v4.jsonl.zstd'))).toEqual(before)
  })

  it('reports planned renames in a dry run and leaves the bytes untouched', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents())
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: false, backupRoot: join(sessions, 'backups') })

    expect(outcome.status).toBe('planned')
    expect(outcome.renames).toEqual([
      { from: 'call-x:ptc:1', to: 'call-x:ptc:1#1' },
      { from: 'call-x:ptc:2', to: 'call-x:ptc:2#1' },
    ])
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(sessions)).toHaveLength(1)
  })

  it('leaves a clean Session alone', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents().slice(0, 6))
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcome).toEqual({ path, status: 'clean', renames: [] })
    expect(await readFile(path)).toEqual(before)
  })

  it('turns a log the shipped reader refuses into one it accepts', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents())
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'zstd' })
    const id = brandString<SessionId>('11111111-1111-4111-8111-111111111111')

    // The defect: the real reader refuses the recorded log.
    const refused = await ctx.sessionPersistence.open(id, 'read').then(
      handle => handle.close().then(() => undefined),
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    expect(String(refused)).toContain('repeats subCallId')

    await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    const read = await ctx.sessionPersistence.open(id, 'read')
    try {
      const result = await read.read()
      expect(result.events.filter(event => event.type === 'tool/ptc-dispatch-start')).toHaveLength(5)
    } finally {
      await read.close()
    }
  })

  it('renames the reply a timed program question waits for', async () => {
    const sessions = await tempRoot()
    // Only the repeated invocation asks, so the reply can only be its answer.
    const path = await realLog(sessions, answeredQuestion(collidingEvents(), false))

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcome.status).toBe('repaired')
    expect(questionReply(await decodeAll(path))?.['callId']).toBe('call-x:ptc:2#1')
  })

  it('refuses a queued question reply in both modes and leaves the bytes alone', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, withQueuedReply(answeredQuestion(collidingEvents(), false)))
    const before = await readFile(path)

    const planned = await repairSessionLog(path, { apply: false, backupRoot: join(sessions, 'backups') })
    expect([planned.status, planned.reason]).toEqual(['failed', expect.stringContaining('does not rewrite')])
    expect(await readFile(path)).toEqual(before)

    const applied = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })
    expect(applied.status).toBe('failed')
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(sessions)).toHaveLength(1)
  })

  it('refuses a reply two questions could own', async () => {
    const sessions = await tempRoot()
    // Both invocations asked the same id, so the answer is ambiguous.
    const path = await realLog(sessions, answeredQuestion(collidingEvents(), true))

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect([outcome.status, outcome.reason]).toEqual(['failed', expect.stringContaining('could settle either question')])
  })

  it('refuses a job settlement no registration proves', async () => {
    const sessions = await tempRoot()
    const events = collidingEvents()
      .filter(event => !(event.type === 'job/registered' && dataOf(event)['jobId'] === 'job-first'))
      .map((event, index) => ({ ...event, seq: SessionSeq(index), time: index + 1 }))
    const path = await realLog(sessions, events)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect([outcome.status, outcome.reason]).toEqual(['failed', expect.stringContaining('no registration that proves')])
  })

  it('releases the write claim after a clean Session', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents().slice(0, 6))

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })
    expect(outcome.status).toBe('clean')

    // A leaked claim would refuse this acquisition.
    const lease = await SessionWriteLease.acquire(sessionDirOf(path), brandString<SessionId>('clean-check'))
    await lease.release()
  })

  it('refuses a log with an incomplete final frame', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents())
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]))
    const before = await readFile(path)

    const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })

    expect([outcome.status, outcome.reason]).toEqual(['failed', expect.stringContaining('incomplete frame')])
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses a Session whose write claim a live holder keeps', async () => {
    const sessions = await tempRoot()
    const path = await realLog(sessions, collidingEvents())
    const lease = await SessionWriteLease.acquire(sessionDirOf(path), brandString<SessionId>('held'))
    try {
      const outcome = await repairSessionLog(path, { apply: true, backupRoot: join(sessions, 'backups') })
      expect(outcome.status).toBe('refused')
    } finally {
      await lease.release()
    }
  })

  it('keeps going after a failure and reports each Session', async () => {
    const sessions = await tempRoot()
    const healthy = await realLog(sessions, collidingEvents())
    const torn = join(sessionDirOf(healthy), 'session.v3.jsonl.zstd')
    await writeFile(torn, Buffer.concat([await compressZstdFrame('{"type":"session","version":3}\n'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]))

    const outcomes: SessionRepairOutcome[] = await repairSessions({ sessionsDir: sessions, apply: true, backupRoot: join(sessions, 'backups') })

    expect(outcomes.map(outcome => [outcome.path, outcome.status])).toEqual([
      [torn, 'failed'],
      [healthy, 'repaired'],
    ])
  })
})
