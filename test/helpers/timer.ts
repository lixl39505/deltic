import type { Timer } from '../../src/utils/timing.js'

export interface ManualTimer extends Timer {
  advance(ms: number): void
  pending(): number
}

export function createManualTimer(): ManualTimer {
  let now = 0
  let seq = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()

  const timer: ManualTimer = {
    setTimeout(fn, ms) {
      const id = ++seq
      jobs.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(handle) {
      jobs.delete(handle as number)
    },
    now() {
      return now
    },
    advance(ms) {
      const target = now + ms

      for (;;) {
        let nextId: number | undefined
        let nextAt = Number.POSITIVE_INFINITY

        for (const [id, job] of jobs) {
          if (job.at <= target && job.at < nextAt) {
            nextId = id
            nextAt = job.at
          }
        }

        if (nextId === undefined) {
          break
        }

        const job = jobs.get(nextId)!
        jobs.delete(nextId)
        now = job.at
        job.fn()
      }

      now = target
    },
    pending() {
      return jobs.size
    },
  }

  return timer
}
