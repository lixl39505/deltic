import { describe, expect, it } from 'vitest'

import { once, runQueue } from '../../../src/utils/async.js'

function drain<T>(
  queue: readonly T[],
  worker: Parameters<typeof runQueue<T>>[1],
): Promise<{ err: unknown | null; complete: boolean }> {
  return new Promise((resolve) => {
    runQueue(queue, worker, (err, complete) => resolve({ err, complete }))
  })
}

describe('once', () => {
  it('invokes the wrapped function a single time', () => {
    let calls = 0
    const wrapped = once((a: number, b: number) => {
      calls += 1
      return a + b
    })

    expect(wrapped(1, 2)).toBe(3)
    expect(wrapped(10, 20)).toBe(3)
    expect(calls).toBe(1)
  })
})

describe('runQueue', () => {
  it('runs items serially in order', async () => {
    const seen: number[] = []
    const { err, complete } = await drain([1, 2, 3], (item, next) => {
      seen.push(item)
      next()
    })

    expect(seen).toEqual([1, 2, 3])
    expect(err).toBeNull()
    expect(complete).toBe(true)
  })

  it('stops on error and reports incomplete', async () => {
    const seen: number[] = []
    const error = new Error('boom')
    const { err, complete } = await drain([1, 2, 3], (item, next) => {
      seen.push(item)
      next(item === 2 ? error : undefined)
    })

    expect(seen).toEqual([1, 2])
    expect(err).toBe(error)
    expect(complete).toBe(false)
  })

  it('stops when next is called with goOn=false', async () => {
    const seen: number[] = []
    const { err, complete } = await drain([1, 2, 3], (item, next) => {
      seen.push(item)
      next(undefined, false)
    })

    expect(seen).toEqual([1])
    expect(err).toBeNull()
    expect(complete).toBe(false)
  })

  it('completes immediately on an empty queue', async () => {
    const { err, complete } = await drain([], () => {
      throw new Error('should not be called')
    })

    expect(err).toBeNull()
    expect(complete).toBe(true)
  })

  it('treats a null error as continue', async () => {
    const { err, complete } = await drain([1], (_item, next) => next(null))

    expect(err).toBeNull()
    expect(complete).toBe(true)
  })

  it('works without a callback', async () => {
    await new Promise<void>((resolve) => {
      runQueue([1], (_item, next) => next())
      setTimeout(resolve, 0)
    })
  })
})
