import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, onTestFinished } from 'vitest'
import ToolRuntime from '../src/index.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

/** Agent backed by a real Session, which accepts the root call and result records. */
function recordingAgent(): Agent {
  const session = Session.create(brandString<SessionId>('position-session'))
  return { id: session.id, session } as Agent
}

describe('tool invocation coordinates', () => {
  it('hands the owning model step to the tool body', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const seen: (ToolExecution['position'] | undefined)[] = []
    ctx.tools.register(defineTool({
      name: 'probe', description: 'Record the owning step.', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async (_args, exec) => {
        seen.push(exec.position)
        return 'ok'
      },
    }))

    const signal = new AbortController().signal
    const agent = recordingAgent()
    await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'probe', arguments: '{}' }],
      agent,
      log: { turn: 3, step: 4 },
      signal,
    })
    await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>('call-2'), name: 'probe', arguments: '{}' }],
      signal,
    })

    expect(seen).toEqual([{ turn: 3, step: 4 }, undefined])
  })
})
