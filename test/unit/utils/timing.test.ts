import { describe, expect, it } from 'vitest'

import { createManualTimer } from '../../helpers/timer.js'
import { createNodeTimer, debounce } from '../../../src/utils/timing.js'

describe('createNodeTimer', () => {
  it('delegates to global timers and a monotonic clock', async () => {
    const timer = createNodeTimer()

    expect(timer.now()).toBeTypeOf('number')

    await new Promise<void>((resolve) => {
      timer.setTimeout(resolve, 1)
    })

    timer.clearTimeout(undefined)
  })
})

describe('debounce', () => {
  it('fires once with the last arguments after silence', () => {
    const timer = createManualTimer()
    const calls: number[] = []
    const wrapped = debounce(200, (value: number) => calls.push(value), timer)

    wrapped(1)
    wrapped(2)
    timer.advance(100)

    expect(calls).toEqual([])
    expect(wrapped.isPending()).toBe(true)

    timer.advance(100)

    expect(calls).toEqual([2])
    expect(wrapped.isPending()).toBe(false)
  })

  it('starts a fresh window for later bursts', () => {
    const timer = createManualTimer()
    const calls: number[] = []
    const wrapped = debounce(100, (value: number) => calls.push(value), timer)

    wrapped(1)
    timer.advance(100)
    wrapped(2)
    timer.advance(99)

    expect(calls).toEqual([1])

    timer.advance(1)

    expect(calls).toEqual([1, 2])
  })

  it('cancel drops the pending call', () => {
    const timer = createManualTimer()
    const calls: number[] = []
    const wrapped = debounce(100, (value: number) => calls.push(value), timer)

    wrapped(1)
    wrapped.cancel()
    timer.advance(500)

    expect(calls).toEqual([])
    expect(wrapped.isPending()).toBe(false)
  })

  it('flush fires the pending call immediately', () => {
    const timer = createManualTimer()
    const calls: number[] = []
    const wrapped = debounce(100, (value: number) => calls.push(value), timer)

    wrapped(1)
    wrapped(2)
    wrapped.flush()

    expect(calls).toEqual([2])
    expect(wrapped.isPending()).toBe(false)

    timer.advance(1000)

    expect(calls).toEqual([2])
  })

  it('flush without pending work is a no-op', () => {
    const timer = createManualTimer()
    const calls: number[] = []
    const wrapped = debounce(100, (value: number) => calls.push(value), timer)

    expect(() => wrapped.flush()).not.toThrow()
    expect(calls).toEqual([])
  })

  it('defaults to the node timer', async () => {
    const calls: number[] = []
    const wrapped = debounce(1, (value: number) => calls.push(value))

    wrapped(1)

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })

    expect(calls).toEqual([1])
  })
})
