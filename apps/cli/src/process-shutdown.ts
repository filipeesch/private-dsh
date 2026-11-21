/** Bounded, ordered process shutdown for the long-lived CLI surfaces. */

/**
 * Hard bound on one graceful shutdown, measured from the first request. Reserved
 * work - the durability barrier and owned-child termination - runs inside this
 * bound, so a stalled phase cannot push the exit past it.
 */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 10_000

/** Part of the hard bound reserved for the durability barrier once a phase stalls. */
export const SHUTDOWN_BARRIER_BUDGET_MS = 1_000

/**
 * Part of the hard bound reserved for terminating owned child processes after a
 * stalled phase, so a child in its own process group is still signalled before
 * the process exits.
 */
export const SHUTDOWN_CHILD_BUDGET_MS = 1_000

/**
 * Slack kept back from the ordered phases so timer and scheduling delay cannot
 * push the reserved steps past the hard bound.
 */
const SHUTDOWN_SCHEDULING_SLACK_MS = 100

/** One ordered teardown phase. */
export interface ShutdownPhase {
  /** Phase name reported when it does not finish. */
  readonly name: string
  /**
   * Mark the phase as the durability barrier. The ordered sequence runs it like
   * any other phase, and a stalled shutdown still runs it before exiting.
   */
  readonly barrier?: true
  /**
   * Run the phase.
   * @param signal - aborted when the ordered sequence runs out of budget, so a waiting phase stops.
   */
  run(signal: AbortSignal): Promise<void>
}

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join the ordered shutdown, then allow natural completion with `code`. */
  shutdown(code: number): Promise<void>
  /** Start or join the ordered shutdown, then exit with `code`. */
  interrupt(code: number): void
}

/** Replaceable process effects; production uses the real ones. */
export interface ProcessShutdownOptions {
  /** Immediate exit; defaults to `process.exit`. */
  forceExit?: (code: number) => void
  /** Natural completion; defaults to setting `process.exitCode`. */
  complete?: (code: number) => void
  /** Hard bound from the first request. */
  timeoutMs?: number
  /** Part of the bound reserved for the barrier. */
  barrierBudgetMs?: number
  /** Part of the bound reserved for owned children. */
  childBudgetMs?: number
  /** Pending and failure diagnostics; defaults to standard error. */
  report?: (message: string) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create one process-exit controller around ordered shutdown phases.
 *
 * The first request fixes the exit code and starts one hard deadline. Later
 * signals join it, because a single terminal interrupt legitimately reaches the
 * process more than once. The ordered phases run until the deadline minus the
 * reserved budgets; a stalled phase then hands over to the durability barrier
 * and to owned-child termination, bounded by those reserves and by the deadline
 * itself. Diagnostics never control progress.
 * @param phases - ordered teardown phases, at most one of them the barrier.
 * @param options - replaceable process effects and deadlines.
 * @returns a controller whose requests coalesce.
 */
export function createProcessShutdown(
  phases: readonly ShutdownPhase[],
  options: ProcessShutdownOptions = {},
): ProcessShutdown {
  const forceExit = options.forceExit ?? ((code: number): void => { process.exit(code) })
  const complete = options.complete ?? ((code: number): void => { process.exitCode = code })
  const report = options.report ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const timeoutMs = options.timeoutMs ?? PROCESS_SHUTDOWN_TIMEOUT_MS
  const barrierBudgetMs = options.barrierBudgetMs ?? SHUTDOWN_BARRIER_BUDGET_MS
  const childBudgetMs = options.childBudgetMs ?? SHUTDOWN_CHILD_BUDGET_MS
  const barrierPhase = phases.find(phase => phase.barrier === true)

  const stop = new AbortController()
  // The barrier is reserved work: a stalled phase aborts `stop`, never this.
  const barrierStop = new AbortController()
  const finished = new Set<string>()
  let pending: Promise<void> | undefined
  let requestedCode = 0
  let hardDeadlineAt = 0
  let softTimer: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let exited = false
  let completed = false
  let currentPhase: string | undefined
  let barrierRun: Promise<void> | undefined
  let stalledPromise: Promise<void> | undefined
  const failedPhases = new Set<string>()
  /** Phases whose `run` has been entered; re-entering would duplicate its work. */
  const started = new Set<string>()

  /** Diagnostics must never decide whether the shutdown progresses. */
  const safeReport = (message: string): void => {
    try {
      report(message)
    } catch (reportFailure: unknown) {
      // A reporter that throws (`reportFailure`) cannot be allowed to strand the
      // exit; with no reporter left the failure is deliberately discarded.
      void reportFailure
    }
  }

  const clearTimers = (): void => {
    if (softTimer !== undefined) clearTimeout(softTimer)
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    softTimer = undefined
    hardTimer = undefined
  }

  const remainingMs = (): number => Math.max(0, hardDeadlineAt - Date.now())

  const forceExitOnce = (code: number): void => {
    if (exited) return
    exited = true
    clearTimers()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (exited || completed) return
    completed = true
    clearTimers()
    complete(code)
  }

  /** Start the barrier once; both the ordered sequence and the stalled path join it. */
  const runBarrier = (): Promise<void> => barrierRun ??= (async () => {
    if (barrierPhase === undefined) return
    await barrierPhase.run(barrierStop.signal)
    finished.add(barrierPhase.name)
  })()

  const pendingNames = (): string[] => phases
    .filter(phase => !finished.has(phase.name))
    .map(phase => phase.name)

  /** Run one phase within `budgetMs`, recording its completion or failure. */
  const runWithin = async (phase: ShutdownPhase, budgetMs: number): Promise<'done' | 'budget' | 'failed'> => {
    currentPhase = phase.name
    started.add(phase.name)
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<'budget'>((resolve) => {
      timer = setTimeout(() => { resolve('budget') }, Math.max(0, budgetMs))
    })
    const work = (phase === barrierPhase ? runBarrier() : phase.run(stop.signal)).then(
      () => 'done' as const,
      (error: unknown) => {
        safeReport(`dsh: shutdown failed in phase "${phase.name}": ${describe(error)}`)
        failedPhases.add(phase.name)
        return 'failed' as const
      },
    )
    try {
      const outcome = await Promise.race([work, budget])
      if (outcome === 'budget') {
        safeReport(`dsh: shutdown phase "${phase.name}" did not finish within its ${budgetMs}ms budget`)
        return 'budget'
      }
      if (outcome === 'failed') return 'failed'
      finished.add(phase.name)
      return 'done'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const runOrdered = async (): Promise<void> => {
    for (const phase of phases) {
      if (stopped) return
      const outcome = await runWithin(phase, remainingMs() - barrierBudgetMs - childBudgetMs - SHUTDOWN_SCHEDULING_SLACK_MS)
      if (outcome !== 'done') {
        await stalled()
        return
      }
    }
    currentPhase = undefined
  }

  /** After the ordered sequence stalls: barrier first, then any remaining phases. */
  const runReserved = async (): Promise<void> => {
    if (barrierPhase !== undefined && !finished.has(barrierPhase.name) && !failedPhases.has(barrierPhase.name)) {
      await runWithin(barrierPhase, Math.min(barrierBudgetMs, remainingMs()))
    }
    for (const phase of phases) {
      if (phase === barrierPhase || finished.has(phase.name) || failedPhases.has(phase.name)) continue
      // A phase that is still running after its budget is abandoned, never
      // started twice: a second run would duplicate teardown work.
      if (started.has(phase.name)) continue
      if (remainingMs() === 0) break
      await runWithin(phase, Math.min(childBudgetMs, remainingMs()))
    }
  }

  /**
   * Finish through the reserved steps. One promise owns the ending, so the soft
   * timer and a stalled phase join it instead of racing to exit.
   * @returns fulfillment after the forced exit was requested.
   */
  const stalled = (): Promise<void> => stalledPromise ??= (async () => {
    stopped = true
    // Phases that observe cancellation stop waiting here; the reserved steps
    // below still run under the hard deadline.
    stop.abort(new Error('shutdown ran out of its ordered budget'))
    await runReserved()
    safeReport(`dsh: shutdown did not finish within ${timeoutMs}ms; pending: ${pendingNames().length === 0 ? 'none' : pendingNames().join(', ')}`)
    forceExitOnce(requestedCode)
  })()

  const start = (code: number, exit: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    requestedCode = code
    hardDeadlineAt = Date.now() + timeoutMs
    const orderedBudgetMs = Math.max(0, timeoutMs - barrierBudgetMs - childBudgetMs - SHUTDOWN_SCHEDULING_SLACK_MS)
    softTimer = setTimeout(() => { void stalled() }, orderedBudgetMs)
    hardTimer = setTimeout(() => {
      safeReport(`dsh: shutdown exceeded its ${timeoutMs}ms deadline; pending: ${pendingNames().length === 0 ? 'none' : pendingNames().join(', ')}`)
      forceExitOnce(requestedCode)
    }, timeoutMs)
    pending = (async () => {
      try {
        await runOrdered()
      } catch (error: unknown) {
        safeReport(`dsh: shutdown failed in phase "${currentPhase ?? 'unknown'}": ${describe(error)}`)
        await stalled()
        return
      }
      // A stalled sequence is still running its reserved steps; the request
      // promise must settle only after them, otherwise a fatal release awaiting
      // it exits before the barrier.
      if (stopped) {
        await stalled()
        return
      }
      clearTimers()
      if (exit) forceExitOnce(code)
      else completeOnce(code)
    })()
    return pending
  }

  return {
    shutdown(code: number) {
      return start(code, false)
    },
    interrupt(code: number) {
      // A repeated signal is the same request; the deadline owns escalation.
      if (pending !== undefined) return
      void start(code, true)
    },
  }
}
