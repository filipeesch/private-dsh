import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { KNOWN_SESSION_EVENT_TYPES, Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ptcSubCallId } from '../src/ptc.ts'
import { PtcExecutor } from '../src/index.ts'

class ScriptedRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'scripted'
  behavior: (spec: PtcRunSpec) => Promise<PtcRunResult> = () => Promise.resolve({ output: [] })

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> { return this.behavior(spec) }
}

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const executor = new PtcExecutor(ctx)
  ctx.tools.setExecutor(executor)
  await ctx.plugin(ScriptedRuntime)
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Echo the fixture value.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'echoed',
  }))
  const runtime = ctx.ptcRuntime as ScriptedRuntime
  const session = Session.create(brandString<SessionId>('sub-call-identity'))
  const agent = { ctx, id: session.id, session } as Agent
  /** Dispatch one program while recording the model step that owns the call. */
  const runProgram = async (
    callId: string,
    position: { turn: number; step: number } | undefined,
  ): Promise<ToolExecutionResult> => {
    const input: ToolExecutionInput = {
      callId: brandString<ToolCallId>(callId),
      name: RUN_CODE_NAME,
      arguments: { code: 'await tools.echo({})', description: 'Echo through the program' },
      agent,
      signal: new AbortController().signal,
    }
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
      agent,
      signal: input.signal,
      ...position === undefined ? {} : { log: position },
    })
    return batch.results[0]!.result
  }
  return { ctx, runtime, session, runProgram }
}

/** Every dispatch-start sub-call id recorded by one Session, in order. */
function startIds(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'tool/ptc-dispatch-start')
    .map(event => String(event.data.subCallId))
}

describe('PTC sub-call identity', () => {
  it('carries the owning model step and keeps the legacy shape without one', () => {
    const callId = brandString<ToolCallId>('call-1')

    expect(String(ptcSubCallId(callId, { turn: 2, step: 5 }, 1))).toBe('call-1:ptc:2:5:1')
    expect(String(ptcSubCallId(callId, { turn: 2, step: 5 }, 3))).toBe('call-1:ptc:2:5:3')
    expect(String(ptcSubCallId(callId, undefined, 1))).toBe('call-1:ptc:1')
  })

  it('keeps ids distinct when a provider reuses one call id across consecutive steps', async () => {
    const { runtime, session, runProgram } = await setup()
    runtime.behavior = async (spec) => {
      await spec.bindings[0]!.functions.echo!({})
      return { output: [] }
    }

    await runProgram('call-reused', { turn: 1, step: 1 })
    await runProgram('call-reused', { turn: 1, step: 2 })

    expect(startIds(session)).toEqual(['call-reused:ptc:1:1:1', 'call-reused:ptc:1:2:1'])
    const settles = session.snapshotEvents()
      .filter(event => event.type === 'tool/ptc-dispatch')
      .map(event => String(event.data.subCallId))
    expect(settles).toEqual(['call-reused:ptc:1:1:1', 'call-reused:ptc:1:2:1'])
  })

  it('numbers every dispatch inside one program without a step', async () => {
    const { runtime, session, runProgram } = await setup()
    runtime.behavior = async (spec) => {
      await spec.bindings[0]!.functions.echo!({})
      await spec.bindings[0]!.functions.echo!({})
      return { output: [] }
    }

    await runProgram('call-1', undefined)

    expect(startIds(session)).toEqual(['call-1:ptc:1', 'call-1:ptc:2'])
  })

  it('produces dispatch records the shipped V4 reader admits', async () => {
    const { runtime, session, runProgram } = await setup()
    runtime.behavior = async (spec) => {
      await spec.bindings[0]!.functions.echo!({})
      return { output: [] }
    }
    await runProgram('call-reused', { turn: 1, step: 1 })
    await runProgram('call-reused', { turn: 1, step: 2 })

    const dispatchRows = session.snapshotEvents()
      .filter(event => event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
      .map(event => ({ type: event.type, data: jsonRecord(event.data) }))
    expect(dispatchRows).toHaveLength(4)

    const first = dispatchRows.slice(0, 2)
    const second = dispatchRows.slice(2)
    expect(() => restoreReleasedV4Artifact(artifact(rows(first, second)), KNOWN_SESSION_EVENT_TYPES)).not.toThrow()

    // The same log written with the legacy, per-invocation counter repeats the
    // sub-call id and is refused, which is the failure this writer removes.
    const legacy = dispatchRows.map(row => ({
      ...row,
      data: { ...row.data, subCallId: 'call-reused:ptc:1' },
    }))
    expect(() => restoreReleasedV4Artifact(artifact(rows(legacy.slice(0, 2), legacy.slice(2))), KNOWN_SESSION_EVENT_TYPES))
      .toThrow(/repeats subCallId/)
  })
})

const step = { turn: 1, step: 1 }
const stepTwo = { turn: 1, step: 2 }

type Row = { type: string; data: Record<string, unknown>; surfaceOp?: unknown }

/** Detach one payload into plain JSON, the representation the reader admits. */
function jsonRecord(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/** Minimal surface and lifecycle rows an admitted dispatch pair needs around it. */
function rows(first: readonly Row[], second: readonly Row[]): Row[] {
  const userMessage = { id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'input' }] }
  const assistant = (at: typeof step, id: string): Row => ({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: at.turn, step: at.step, stream: [],
      message: {
        id, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: 'call-reused', name: 'run_code', arguments: '{}' }],
      },
    },
  })
  const result = (at: typeof step, id: string): Row => ({
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: at.turn, step: at.step,
      message: {
        id, role: 'tool', source: { kind: 'tool', callId: 'call-reused' }, toolCallId: 'call-reused',
        content: [{ type: 'text', text: 'done' }],
      },
    },
  })
  const toolCall = (at: typeof step): Row => ({
    type: 'tool/call',
    data: { ...at, callId: 'call-reused', name: 'run_code', arguments: '{}' },
  })
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userMessage, surfaceOp: 'append' },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } } },
    { type: 'step/start', data: step },
    assistant(step, 'assistant-1'),
    toolCall(step),
    ...first,
    result(step, 'result-1'),
    { type: 'step/end', data: step },
    { type: 'step/start', data: stepTwo },
    assistant(stepTwo, 'assistant-2'),
    toolCall(stepTwo),
    ...second,
    result(stepTwo, 'result-2'),
    { type: 'step/end', data: stepTwo },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Assemble one V4 artifact from ordered rows, sequencing them as the reader expects. */
function artifact(items: readonly Row[]): SessionFormatArtifact {
  const events = items.map((item, seq) => jsonRecord({ ...item, seq, time: seq + 1 }) as SessionFormatEvent)
  return {
    header: { version: 4, id: brandString<SessionId>('sub-call-identity'), createdAt: 1, isSeeded: false, delegationDepth: 0 },
    events,
    inheritedEventCount: 0,
  }
}
