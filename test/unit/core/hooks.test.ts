import { describe, expect, it } from 'vitest'

import { UnknownHookError } from '../../../src/errors.js'
import { HookRegistryImpl } from '../../../src/core/hooks.js'

describe('HookRegistryImpl', () => {
  it('runs handlers serially in registration order', async () => {
    const hooks = new HookRegistryImpl()
    const order: string[] = []

    hooks.on('beforeCompile', () => {
      order.push('first')
    })
    hooks.on('beforeCompile', async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
      order.push('second')
    })
    hooks.on('beforeCompile', () => {
      order.push('third')
    })

    await hooks.fire('beforeCompile', { session: {} as never })

    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('resolves when no handler is registered', async () => {
    const hooks = new HookRegistryImpl()

    await expect(hooks.fire('init', { compiler: {} as never })).resolves.toBeUndefined()
    expect(hooks.listenerCount('init')).toBe(0)
  })

  it('rejects and stops later handlers when one fails', async () => {
    const hooks = new HookRegistryImpl()
    const order: string[] = []
    const boom = new Error('boom')

    hooks.on('clean', () => {
      order.push('before')
    })
    hooks.on('clean', () => Promise.reject(boom))
    hooks.on('clean', () => {
      order.push('after')
    })

    await expect(hooks.fire('clean', { expired: [] })).rejects.toBe(boom)
    expect(order).toEqual(['before'])
  })

  it('unsubscribes handlers', async () => {
    const hooks = new HookRegistryImpl()
    const calls: number[] = []

    const off = hooks.on('afterCompile', () => {
      calls.push(1)
    })
    hooks.on('afterCompile', () => {
      calls.push(2)
    })

    expect(hooks.listenerCount('afterCompile')).toBe(2)

    off()
    off()

    await hooks.fire('afterCompile', { session: {} as never })

    expect(calls).toEqual([2])
    expect(hooks.listenerCount('afterCompile')).toBe(1)
  })

  it('unsubscribing an unknown handler is a no-op', () => {
    const hooks = new HookRegistryImpl()

    expect(() => {
      const off = hooks.on('init', () => {})
      off()
      off()
    }).not.toThrow()
  })

  it('throws on unknown hook names', async () => {
    const hooks = new HookRegistryImpl()

    expect(() => {
      hooks.on('nope' as 'init', () => {})
    }).toThrow(UnknownHookError)

    await expect(
      hooks.fire('nope' as 'init', {} as never),
    ).rejects.toThrow(UnknownHookError)
  })
})
