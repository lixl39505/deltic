export type QueueNext = (err?: unknown, goOn?: boolean) => void

export type QueueWorker<T> = (item: T, next: QueueNext) => void

export type QueueCallback = (err: unknown | null, complete: boolean) => void

export function once<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  let called = false
  let result: R | undefined

  return (...args: Args) => {
    if (!called) {
      called = true
      result = fn(...args)
    }

    return result as R
  }
}

// Serial async queue. `fn` must call `next` exactly once per item;
// an error (or `goOn === false`) stops the queue.
export function runQueue<T>(
  queue: readonly T[],
  fn: QueueWorker<T>,
  cb?: QueueCallback,
): void {
  const stop = (err: unknown | null, index: number): void => {
    cb?.(err, index >= queue.length)
  }

  const step = (index: number): void => {
    if (index >= queue.length) {
      stop(null, index)
      return
    }

    fn(queue[index]!, (err, goOn) => {
      if (err || goOn === false) {
        stop(err ?? null, index)
      } else {
        step(index + 1)
      }
    })
  }

  Promise.resolve().then(() => step(0))
}
