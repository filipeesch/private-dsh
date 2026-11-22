/**
 * Ordered shutdown phases for one booted profile: stop running work, make the
 * Session logs durable, then tear the tree down. The launcher owns the ordering
 * so a forced exit can still run the durability barrier.
 * @module @deepseek-ai/dsh/shutdown-phases
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ShutdownPhase } from './process-shutdown.ts'

/**
 * Stop running turns and wait for their settlement, so cancellation outcomes are
 * recorded before the durability barrier runs.
 * @param ctx - booted tree, or undefined while startup is still incomplete.
 * @param signal - aborted when the shutdown deadline expires.
 */
export async function quiesceAgents(ctx: Context | undefined, signal: AbortSignal): Promise<void> {
  const agents = ctx?.get('agents')
  if (agents === undefined) return
  signal.throwIfAborted()
  const live = agents.list()
  for (const agent of live) agent.cancel({ kind: 'disposed' })
  await Promise.all(live.map(agent => agent.whenIdle()))
}

/**
 * Flush every open Session write handle: the durability barrier.
 * @param ctx - booted tree, or undefined while startup is still incomplete.
 */
export async function flushSessions(ctx: Context | undefined): Promise<void> {
  await ctx?.get('sessionPersistence')?.flush()
}

/**
 * Build the ordered phases one profile shutdown runs.
 * @param current - the live tree, resolved at phase time because a signal may arrive before boot settles.
 * @param teardown - whole-application disposal, including owned child processes.
 * @returns the ordered phases, with the durability barrier marked.
 */
export function createProfileShutdownPhases(
  current: () => Context | undefined,
  teardown: () => Promise<void>,
): readonly ShutdownPhase[] {
  return [
    { name: 'quiesce', run: (signal: AbortSignal) => quiesceAgents(current(), signal) },
    { name: 'flush', barrier: true, run: () => flushSessions(current()) },
    { name: 'teardown', run: teardown },
  ]
}
