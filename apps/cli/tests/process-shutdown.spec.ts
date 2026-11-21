import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProcessShutdown,
  PROCESS_SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_BARRIER_BUDGET_MS,
  type ShutdownPhase,
} from '../src/process-shutdown.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

/** Flush pending microtasks so a forced path can reach its exit call. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('process shutdown', () => {
  it('pins the committed deadline and the barrier reserve', () => {
    expect(PROCESS_SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(SHUTDOWN_BARRIER_BUDGET_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_BARRIER_BUDGET_MS).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS)
  })

  it('runs the phases in order before recording natural completion', async () => {
    const order: string[] = []
    const complete = vi.fn()
    const exit = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: async () => { order.push('quiesce') } },
      { name: 'flush', run: async () => { order.push('flush') } },
      { name: 'teardown', run: async () => { order.push('teardown') } },
    ], { forceExit: exit, complete })

    await shutdown.shutdown(0)

    expect(order).toEqual(['quiesce', 'flush', 'teardown'])
    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('uses process.exitCode for default normal completion', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(_code => undefined as never)
    const originalExitCode = process.exitCode
    process.exitCode = undefined
    const shutdown = createProcessShutdown([{ name: 'flush', run: () => Promise.resolve() }])

    try {
      await shutdown.shutdown(7)

      expect(process.exitCode).toBe(7)
      expect(exit).not.toHaveBeenCalled()
    } finally {
      process.exitCode = originalExitCode
    }
  })

  it('exits with the request code once the phases finish', async () => {
    const exit = vi.fn()
    const shutdown = createProcessShutdown([{ name: 'flush', run: () => Promise.resolve() }], { forceExit: exit })

    shutdown.interrupt(130)
    await shutdown.shutdown(130)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('treats a repeated interrupt as the same request instead of forcing exit', async () => {
    const disposal = deferred()
    const exit = vi.fn()
    const shutdown = createProcessShutdown([{ name: 'teardown', run: () => disposal.promise }], { forceExit: exit })

    shutdown.interrupt(130)
    await settle()
    shutdown.interrupt(130)
    shutdown.interrupt(130)

    expect(exit).not.toHaveBeenCalled()

    disposal.resolve()
    await shutdown.shutdown(130)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('keeps the exit code of the first request when another signal arrives', async () => {
    const disposal = deferred()
    const exit = vi.fn()
    const shutdown = createProcessShutdown([{ name: 'teardown', run: () => disposal.promise }], { forceExit: exit })

    shutdown.interrupt(130)
    await settle()
    shutdown.interrupt(0)

    disposal.resolve()
    await shutdown.shutdown(0)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('coalesces natural shutdown calls with a signal request', async () => {
    const disposal = deferred()
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown([{ name: 'teardown', run: () => disposal.promise }], { forceExit: exit, complete })

    const first = shutdown.shutdown(1)
    const second = shutdown.shutdown(2)
    expect(second).toBe(first)

    disposal.resolve()
    await first

    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports pending phases and still runs the barrier when the deadline expires', async () => {
    vi.useFakeTimers()
    const flush = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const report = vi.fn()
    const phases: ShutdownPhase[] = [
      { name: 'quiesce', run: () => new Promise<void>(() => {}) },
      { name: 'flush', barrier: true, run: flush },
      { name: 'teardown', run: () => Promise.resolve() },
    ]
    const shutdown = createProcessShutdown(phases, { forceExit: exit, report, timeoutMs: 1_000, barrierBudgetMs: 200 })

    shutdown.interrupt(130)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    expect(report).toHaveBeenCalledWith(expect.stringContaining('did not finish within 1000ms'))
    expect(report).toHaveBeenCalledWith(expect.stringContaining('pending: quiesce, teardown'))
    expect(flush).toHaveBeenCalledOnce()

    await settle()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('abandons a barrier that outlives its reserve and exits anyway', async () => {
    vi.useFakeTimers()
    const flush = vi.fn(() => new Promise<void>(() => {}))
    const exit = vi.fn()
    const report = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: () => new Promise<void>(() => {}) },
      { name: 'flush', barrier: true, run: flush },
    ], { forceExit: exit, report, timeoutMs: 1_000, barrierBudgetMs: 200 })

    shutdown.interrupt(130)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    await settle()

    expect(flush).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('did not finish within its 200ms reserve'))
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('reports a failing phase and exits with the request code', async () => {
    const exit = vi.fn()
    const report = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'flush', run: () => Promise.resolve() },
      { name: 'teardown', run: () => Promise.reject(new Error('dispose failed')) },
    ], { forceExit: exit, report })

    shutdown.interrupt(143)
    await shutdown.shutdown(143)

    expect(report).toHaveBeenCalledWith(expect.stringContaining('phase "teardown"'))
    expect(report).toHaveBeenCalledWith(expect.stringContaining('dispose failed'))
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(143)
  })
})
