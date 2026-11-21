import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProcessShutdown,
  PROCESS_SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_BARRIER_BUDGET_MS,
  SHUTDOWN_CHILD_BUDGET_MS,
  type ShutdownPhase,
} from '../src/process-shutdown.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

/** Flush pending microtasks so a reserved path can reach its exit call. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('process shutdown', () => {
  it('bounds the shutdown with one hard deadline that contains the reserves', () => {
    expect(PROCESS_SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(SHUTDOWN_BARRIER_BUDGET_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_CHILD_BUDGET_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_BARRIER_BUDGET_MS + SHUTDOWN_CHILD_BUDGET_MS).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS)
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

  it('lets a fatal failure join a pending signal shutdown without changing its code', async () => {
    const disposal = deferred()
    const flush = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: () => disposal.promise },
      { name: 'flush', barrier: true, run: flush },
    ], { forceExit: exit, complete })

    shutdown.interrupt(130)
    await settle()
    // The fatal path calls shutdown(1); it must join, not override, the request.
    const joined = shutdown.shutdown(1)

    disposal.resolve()
    await joined

    expect(flush).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
    expect(complete).not.toHaveBeenCalled()
  })

  it('runs the barrier and the remaining phases when a phase stalls, then exits inside the deadline', async () => {
    const order: string[] = []
    const exit = vi.fn()
    const report = vi.fn()
    const phases: ShutdownPhase[] = [
      { name: 'quiesce', run: () => new Promise<void>(() => {}) },
      { name: 'flush', barrier: true, run: async () => { order.push('flush') } },
      { name: 'teardown', run: async () => { order.push('teardown') } },
    ]
    const shutdown = createProcessShutdown(phases, {
      forceExit: exit, report, timeoutMs: 400, barrierBudgetMs: 40, childBudgetMs: 40,
    })

    shutdown.interrupt(130)
    await shutdown.shutdown(130)

    expect(order).toEqual(['flush', 'teardown'])
    expect(report).toHaveBeenCalledWith(expect.stringContaining('did not finish'))
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('abandons a barrier that outlives its reserve and still signals owned children', async () => {
    const teardown = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const report = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: () => new Promise<void>(() => {}) },
      { name: 'flush', barrier: true, run: () => new Promise<void>(() => {}) },
      { name: 'teardown', run: teardown },
    ], { forceExit: exit, report, timeoutMs: 400, barrierBudgetMs: 40, childBudgetMs: 40 })

    shutdown.interrupt(130)
    await shutdown.shutdown(130)

    expect(report).toHaveBeenCalledWith(expect.stringContaining('"flush" did not finish within its'))
    expect(teardown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('reports a failing phase, still runs the reserved steps, and exits with the request code', async () => {
    const barrier = vi.fn(() => Promise.resolve())
    const teardown = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const report = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: () => Promise.reject(new Error('cancel failed')) },
      { name: 'flush', barrier: true, run: barrier },
      { name: 'teardown', run: teardown },
    ], { forceExit: exit, report })

    shutdown.interrupt(143)
    await shutdown.shutdown(143)

    expect(report).toHaveBeenCalledWith(expect.stringContaining('phase "quiesce"'))
    expect(report).toHaveBeenCalledWith(expect.stringContaining('cancel failed'))
    expect(barrier).toHaveBeenCalledOnce()
    expect(teardown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(143)
  })

  it('exits even when the diagnostic reporter throws', async () => {
    const exit = vi.fn()
    const shutdown = createProcessShutdown([
      { name: 'quiesce', run: () => new Promise<void>(() => {}) },
      { name: 'flush', barrier: true, run: () => Promise.resolve() },
    ], {
      forceExit: exit,
      report: () => { throw new Error('stderr is gone') },
      timeoutMs: 400, barrierBudgetMs: 40, childBudgetMs: 40,
    })

    shutdown.interrupt(130)
    await shutdown.shutdown(130)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })
})
