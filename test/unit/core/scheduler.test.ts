import { describe, expect, it } from 'vitest'

import { TaskScheduler } from '../../../src/core/scheduler.js'

describe('TaskScheduler', () => {
  it('runs queued tasks serially in FIFO order', async () => {
    const scheduler = new TaskScheduler()
    const order: number[] = []

    const first = scheduler.push(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10)
      })
      order.push(1)
      return 'one'
    })
    const second = scheduler.push(() => {
      order.push(2)
      return 'two'
    })

    expect(scheduler.size).toBe(1)
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    expect(order).toEqual([1, 2])
  })

  it('executes tasks pushed while a batch is running', async () => {
    const scheduler = new TaskScheduler()
    const order: string[] = []
    let later: Promise<void> = Promise.resolve()

    const first = scheduler.push(async () => {
      order.push('first-start')
      later = scheduler.push(() => {
        order.push('second')
      })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
      order.push('first-end')
    })

    await first
    await later

    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(scheduler.running).toBe(false)
  })

  it('rejects the failed task and aborts the remaining queue', async () => {
    const scheduler = new TaskScheduler()
    const boom = new Error('boom')

    const failing = scheduler.push(() => Promise.reject(boom))
    const queued = scheduler.push(() => 'never')

    await expect(failing).rejects.toBe(boom)
    await expect(queued).rejects.toBe(boom)
  })

  it('rejects queued tasks on abort', async () => {
    const scheduler = new TaskScheduler()
    const stop = new Error('stopped')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = scheduler.push(() => gate)
    const queued = scheduler.push(() => 'never')

    scheduler.abort(stop)

    await expect(queued).rejects.toBe(stop)
    expect(scheduler.size).toBe(0)

    release()
    await running
  })

  it('reports the running state', async () => {
    const scheduler = new TaskScheduler()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const task = scheduler.push(() => gate)

    expect(scheduler.running).toBe(true)

    release()
    await task

    expect(scheduler.running).toBe(false)
  })
})
