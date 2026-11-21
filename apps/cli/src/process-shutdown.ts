/** Bounded, ordered process shutdown for the long-lived CLI surfaces. */

/**
 * Committed deadline for one graceful shutdown. A single terminal interrupt can
 * arrive more than once through a process chain (the terminal signals the whole
 * group, and a wrapper re-sends it to its child), so elapsed time - not a
 * repeated signal - decides when an unfinished teardown gives up.
 */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Budget reserved for the durability barrier once the deadline expires, so an
 * abandoned teardown still leaves a readable Session log behind.
 */
export const SHUTDOWN_BARRIER_BUDGET_MS = 2_000

/** One ordered teardown phase. */
export interface ShutdownPhase {
  /** Phase name reported when it outlives the deadline. */
  readonly name: string
  /**
   * Mark the phase as the durability barrier. The ordered sequence runs it like
   * any other phase, and a forced exit runs it too when the deadline expired
   * before it finished.
   */
  readonly barrier?: true
  /**
   * Run the phase.
   * @param signal - aborted when the deadline expires, so a waiting phase stops.
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
  /** Deadline before the barrier reserve applies. */
  timeoutMs?: number
  /** Reserve granted to the barrier once the deadline expires. */
  barrierBudgetMs?: number
  /** Pending and failure diagnostics; defaults to standard error. */
  report?: (message: string) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create one process-exit controller around ordered shutdown phases.
 *
 * The first request fixes the exit code. Later signals join it, because one
 * terminal interrupt legitimately reaches the process more than once; only the
 * deadline forces an exit, and that path still runs the durability barrier with
 * its own budget.
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
  const barrierPhase = phases.find(phase => phase.barrier === true)

  const stop = new AbortController()
  const barrierStop = new AbortController()
  const finished = new Set<string>()
  let pending: Promise<void> | undefined
  let requestedCode = 0
  let deadline: ReturnType<typeof setTimeout> | undefined
  let expired = false
  let exited = false
  let completed = false
  let currentPhase: string | undefined
  let barrierRun: Promise<void> | undefined

  const clearDeadline = (): void => {
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
  }

  const forceExitOnce = (code: number): void => {
    if (exited) return
    exited = true
    clearDeadline()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (exited || completed) return
    completed = true
    clearDeadline()
    complete(code)
  }

  /** Start the barrier once; both the ordered sequence and the forced path join it. */
  const runBarrier = (): Promise<void> => barrierRun ??= (async () => {
    if (barrierPhase === undefined) return
    await barrierPhase.run(barrierStop.signal)
    finished.add(barrierPhase.name)
  })()

  const runOrdered = async (): Promise<void> => {
    for (const phase of phases) {
      if (expired) return
      currentPhase = phase.name
      if (phase === barrierPhase) await runBarrier()
      else await phase.run(stop.signal)
      finished.add(phase.name)
    }
    currentPhase = undefined
  }

  /** Phases still unfinished, excluding the barrier the forced path is about to run. */
  const pendingNames = (): string[] => phases
    .filter(phase => !finished.has(phase.name) && phase !== barrierPhase)
    .map(phase => phase.name)

  /** Give the barrier its reserved budget, aborting it when the budget runs out. */
  const runBarrierWithin = async (): Promise<void> => {
    if (barrierPhase === undefined || finished.has(barrierPhase.name)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const budgetState = { expired: false }
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        budgetState.expired = true
        barrierStop.abort(new Error('shutdown barrier budget expired'))
        resolve()
      }, barrierBudgetMs)
    })
    const work = runBarrier().then(
      () => undefined,
      (error: unknown) => {
        report(`dsh: durability barrier failed after the shutdown deadline: ${describe(error)}`)
      },
    )
    try {
      await Promise.race([work, budget])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (budgetState.expired && !finished.has(barrierPhase.name)) {
      report(`dsh: durability barrier did not finish within its ${barrierBudgetMs}ms reserve; the Session log may be incomplete`)
    }
  }

  const onDeadline = (): void => {
    if (expired) return
    expired = true
    clearDeadline()
    const names = pendingNames()
    report(`dsh: shutdown did not finish within ${timeoutMs}ms; pending: ${names.length === 0 ? 'none' : names.join(', ')}`)
    stop.abort(new Error('shutdown deadline expired'))
    void (async () => {
      await runBarrierWithin()
      forceExitOnce(requestedCode)
    })()
  }

  const start = (code: number, exit: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    requestedCode = code
    deadline = setTimeout(() => { onDeadline() }, timeoutMs)
    pending = (async () => {
      try {
        await runOrdered()
      } catch (error: unknown) {
        if (expired) return
        report(`dsh: shutdown failed in phase "${currentPhase ?? 'unknown'}": ${describe(error)}`)
        forceExitOnce(requestedCode)
        return
      }
      if (expired) return
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
