export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export function createNodeTimer(): Timer {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
    now: () => performance.now(),
  }
}

export interface Debounced<Args extends unknown[]> {
  (...args: Args): void
  cancel(): void
  flush(): void
  isPending(): boolean
}

// Trailing debounce: only the last call within a burst fires, after `delay`
// ms of silence. `flush()` fires the pending call immediately.
export function debounce<Args extends unknown[]>(
  delay: number,
  fn: (...args: Args) => void,
  timer: Timer = createNodeTimer(),
): Debounced<Args> {
  let handle: unknown
  let pendingArgs: Args | undefined
  let hasPending = false

  const invoke = (): void => {
    handle = undefined

    if (!hasPending) {
      return
    }

    hasPending = false
    const args = pendingArgs!
    pendingArgs = undefined
    fn(...args)
  }

  const wrapped = ((...args: Args) => {
    pendingArgs = args
    hasPending = true
    timer.clearTimeout(handle)
    handle = timer.setTimeout(invoke, delay)
  }) as Debounced<Args>

  wrapped.cancel = () => {
    timer.clearTimeout(handle)
    handle = undefined
    hasPending = false
    pendingArgs = undefined
  }

  wrapped.flush = () => {
    timer.clearTimeout(handle)
    handle = undefined
    invoke()
  }

  wrapped.isPending = () => hasPending

  return wrapped
}
