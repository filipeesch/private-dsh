import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProfileShutdownPhases, flushSessions, quiesceAgents } from '../src/shutdown-phases.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-phases-'))
  roots.push(root)
  return root
}

/** The live surface the quiesce phase drives. */
interface FakeAgent {
  readonly id: SessionId
  readonly cancel: ReturnType<typeof vi.fn>
  readonly whenIdle: ReturnType<typeof vi.fn>
}

function fakeAgent(): FakeAgent {
  return {
    id: brandString<SessionId>('agent-1'),
    cancel: vi.fn(),
    whenIdle: vi.fn(() => Promise.resolve()),
  }
}

describe('shutdown phases', () => {
  it('cancels every live agent and waits for settlement', async () => {
    const first = fakeAgent()
    const second = fakeAgent()
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { list: () => [first, second] } as never)

    await quiesceAgents(ctx, new AbortController().signal)

    expect(first.cancel).toHaveBeenCalledWith({ kind: 'disposed' })
    expect(second.cancel).toHaveBeenCalledWith({ kind: 'disposed' })
    expect(first.whenIdle).toHaveBeenCalledOnce()
    expect(second.whenIdle).toHaveBeenCalledOnce()
  })

  it('stops before cancelling when the deadline already expired', async () => {
    const agent = fakeAgent()
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { list: () => [agent] } as never)
    const expired = new AbortController()
    expired.abort(new Error('shutdown deadline expired'))

    await expect(quiesceAgents(ctx, expired.signal)).rejects.toThrow(/deadline expired/)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('does nothing without a booted tree or without those services', async () => {
    await quiesceAgents(undefined, new AbortController().signal)
    await flushSessions(undefined)
    const ctx = new Context()
    contexts.push(ctx)
    await quiesceAgents(ctx, new AbortController().signal)
    await flushSessions(ctx)
  })

  it('flushes the persistence barrier once', async () => {
    const flush = vi.fn(() => Promise.resolve())
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionPersistence', { flush } as never)

    await flushSessions(ctx)

    expect(flush).toHaveBeenCalledOnce()
  })

  it('makes every accepted Session event readable after the barrier', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const id = brandString<SessionId>('barrier-session')
    const header: SessionHeader = { version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: root }
    const write = await ctx.sessionPersistence.create(header)
    const events = [
      { type: 'turn/start' as const, seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start' as const, seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    ]
    await write.append(events)

    await flushSessions(ctx)

    const read = await ctx.sessionPersistence.open(id, 'read')
    try {
      const result = await read.read()
      expect(result.events.map(event => event.type)).toEqual(['turn/start', 'step/start'])
    } finally {
      await read.close()
      await write.close()
    }
  })

  it('orders quiesce, the barrier, and teardown', async () => {
    const order: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { list: () => [{ cancel: () => { order.push('cancel') }, whenIdle: () => Promise.resolve() }] } as never)
    ctx.provide('sessionPersistence', { flush: () => { order.push('flush'); return Promise.resolve() } } as never)

    const phases = createProfileShutdownPhases(() => ctx, async () => { order.push('teardown') })
    expect(phases.map(phase => phase.name)).toEqual(['quiesce', 'flush', 'teardown'])
    expect(phases.find(phase => phase.barrier === true)?.name).toBe('flush')
    const stop = new AbortController()
    for (const phase of phases) await phase.run(stop.signal)

    expect(order).toEqual(['cancel', 'flush', 'teardown'])
  })
})
