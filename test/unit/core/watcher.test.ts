import { describe, expect, it, vi } from 'vitest'

import { createWatchHandlers } from '../../../src/core/watcher.js'
import { createManualTimer } from '../../helpers/timer.js'
import type { Compiler } from '../../../src/compiler.js'
import type { Logger } from '../../../src/utils/logger.js'

const settled = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

function fakeCompiler(overrides: {
  cleanSpec?: ((paths: string[]) => Promise<string[]>) | null
  incrementResult?: Promise<void>
} = {}) {
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  const capability = (name: string): unknown => {
    if (name !== 'cleanSpec') {
      return undefined
    }

    return 'cleanSpec' in overrides
      ? overrides.cleanSpec
      : async (paths: string[]) => paths
  }

  const compiler = {
    options: { watch: { debounceMs: 10 }, timer: createManualTimer() },
    logger,
    capability,
    incrementCompile: vi.fn(() =>
      overrides.incrementResult ?? Promise.resolve(),
    ),
    schedule: vi.fn(async (fn: () => Promise<void>) => fn()),
    fire: vi.fn(async () => {}),
  }

  return { compiler: compiler as unknown as Compiler, logger, raw: compiler }
}

describe('createWatchHandlers', () => {
  it('dispatches one compile per unique path after the debounce', async () => {
    const { compiler, raw } = fakeCompiler()
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'change')
    handlers.record('/src/a.js', 'change')
    handlers.record('/src/b.js', 'add')
    handlers.flush()
    await settled()

    expect(raw.incrementCompile).toHaveBeenCalledOnce()
    expect(raw.incrementCompile).toHaveBeenCalledWith(['/src/a.js', '/src/b.js'])
  })

  it('routes the last unlink of a burst to the clean path', async () => {
    const { compiler, raw } = fakeCompiler()
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'change')
    handlers.record('/src/a.js', 'unlink')
    handlers.flush()
    await settled()

    expect(raw.incrementCompile).not.toHaveBeenCalled()
    expect(raw.schedule).toHaveBeenCalledOnce()
    expect(raw.fire).toHaveBeenCalledWith('clean', { expired: ['/src/a.js'] })
  })

  it('skips cleanup when the clean capability is missing', async () => {
    const { compiler, raw } = fakeCompiler({
      cleanSpec: undefined as unknown as ((paths: string[]) => Promise<string[]>),
    })
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'unlink')
    handlers.flush()
    await settled()

    expect(raw.schedule).not.toHaveBeenCalled()
    expect(raw.logger.error).not.toHaveBeenCalled()
  })

  it('logs compile failures instead of crashing', async () => {
    const { compiler, raw } = fakeCompiler({
      incrementResult: Promise.reject(new Error('compile boom')),
    })
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'change')
    handlers.flush()
    await settled()

    expect(raw.logger.error).toHaveBeenCalledWith('compile boom')
  })

  it('logs non-error rejections as plain strings', async () => {
    const { compiler, raw } = fakeCompiler({
      incrementResult: Promise.reject('string compile boom'),
      cleanSpec: () => Promise.reject('string clean boom'),
    })
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'change')
    handlers.record('/src/b.js', 'unlink')
    handlers.flush()
    await settled()

    expect(raw.logger.error).toHaveBeenCalledWith('string compile boom')
    expect(raw.logger.error).toHaveBeenCalledWith('string clean boom')
  })

  it('logs cleanup failures instead of crashing', async () => {
    const { compiler, raw } = fakeCompiler({
      cleanSpec: async () => {
        throw new Error('clean boom')
      },
    })
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'unlink')
    handlers.flush()
    await settled()

    expect(raw.logger.error).toHaveBeenCalledWith('clean boom')
  })

  it('debounces bursts with the configured timer', () => {
    const { compiler, raw } = fakeCompiler()
    const handlers = createWatchHandlers(compiler)

    handlers.record('/src/a.js', 'change')

    expect(raw.incrementCompile).not.toHaveBeenCalled()

    ;(compiler.options as unknown as { timer: { advance(ms: number): void } })
      .timer.advance(10)

    expect(raw.incrementCompile).toHaveBeenCalledOnce()
  })
})
