/** Exercise host reset and a tool that remains pending until its evaluation ends. */
import { CodeResetFailedError, PtcExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-ptc'

export const name = 'ptc-host-reset-fixture'
export const inject = executorInject

/** Mount the shipped executor and drive recovery through its host API. */
export function apply(ctx) {
  const executor = new PtcExecutor(ctx)
  ctx.tools.setExecutor(executor)
  const runtime = ctx.ptcRuntime
  const release = runtime.release.bind(runtime)
  let failRelease = true
  runtime.release = async owner => {
    if (failRelease) { failRelease = false; throw new Error('fixture process cleanup failed') }
    await release(owner)
  }
  ctx.effect(() => () => { runtime.release = release })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.callId === 'call_keep:ptc-2026-11:1:1:2') {
      // Keep the tool pending until the program is cancelled, then fail with a
      // fixed message: an in-flight filesystem call names whichever operation
      // the abort interrupted, which differs between platforms.
      if (!exec.signal.aborted) {
        await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      }
      throw new Error('fixture: pending tool aborted after cancellation')
    }
    const result = await next()
    if (exec.callId === 'call_isolated') {
      try { await executor.reset(exec.agent) } catch (error) {
        if (!(error instanceof CodeResetFailedError)) throw error
      }
    }
    if (exec.callId === 'call_blocked') await executor.reset(exec.agent)
    return result
  })
}
