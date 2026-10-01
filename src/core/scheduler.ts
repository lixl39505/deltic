export type TaskFn<T> = () => T | Promise<T>

interface QueueEntry {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

// Per-instance FIFO queue. Tasks pushed while a batch is running wait for it;
// a failed task rejects itself and every task still queued (abort semantics).
export class TaskScheduler {
  readonly #waiting: QueueEntry[] = []
  #running = false

  push<T>(fn: TaskFn<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#waiting.push({
        run: () => Promise.resolve().then(fn),
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.#drain()
    })
  }

  #drain(): void {
    if (this.#running) {
      return
    }

    this.#running = true
    void this.#loop()
  }

  async #loop(): Promise<void> {
    while (this.#waiting.length > 0) {
      const entry = this.#waiting.shift()!

      try {
        entry.resolve(await entry.run())
      } catch (error) {
        entry.reject(error)

        for (const queued of this.#waiting.splice(0)) {
          queued.reject(error)
        }

        break
      }
    }

    this.#running = false
  }

  abort(error: unknown): void {
    for (const queued of this.#waiting.splice(0)) {
      queued.reject(error)
    }
  }

  get size(): number {
    return this.#waiting.length
  }

  get running(): boolean {
    return this.#running
  }
}
