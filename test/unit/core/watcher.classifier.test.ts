import { describe, expect, it, vi } from 'vitest'

import {
  RecursiveWatcher,
  type SourceWatcher,
  type WatcherDeps,
} from '../../../src/core/watcher.js'
import type { Compiler } from '../../../src/compiler.js'
import type { FSWatcher, Stats } from 'node:fs'
import type { Logger } from '../../../src/utils/logger.js'

const SRC = 'C:/proj/src'

const dirStat = (): Stats => ({ isDirectory: (): boolean => true }) as unknown as Stats
const fileStat = (): Stats => ({ isDirectory: (): boolean => false }) as unknown as Stats

function makeCompiler(ignore: string[] = []): Compiler {
  return {
    sourceDir: SRC,
    options: { ignore, watch: { debounceMs: 10, chokidar: {} } },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    capability: () => undefined,
    incrementCompile: vi.fn(async () => {}),
    schedule: vi.fn(async (fn: () => Promise<void>) => fn()),
    fire: vi.fn(async () => {}),
  } as unknown as Compiler
}

interface DepsHarness {
  /** Feeds a raw fs event and waits for its classification to settle. */
  listener(event: string, fileName: string | Buffer | null): Promise<void>
  watcher: RecursiveWatcher
  events: Array<{ type: string; filePath: string }>
  errors: Error[]
  close: ReturnType<typeof vi.fn>
  ready: Promise<void>
}

interface DepsOverrides {
  initialEntries?: string[]
  statFor?(filePath: string): Promise<Stats>
  readdirFor?(filePath: string): Promise<string[]>
  initialError?: unknown
}

async function createWatcher(
  ignore: string[] = [],
  overrides: DepsOverrides = {},
): Promise<DepsHarness> {
  const events: Array<{ type: string; filePath: string }> = []
  const errors: Error[] = []
  const close = vi.fn()

  let rawListener!: (event: string, fileName: string | Buffer | null) => void

  const watchFn = vi.fn(
    (
      _path: string,
      _options: { recursive: boolean },
      callback: (event: string, fileName: string | Buffer | null) => void,
    ): FSWatcher => {
      rawListener = callback
      return { close } as unknown as FSWatcher
    },
  )

  const statFn = vi.fn((filePath: string): Promise<Stats> =>
    overrides.statFor?.(filePath) ?? Promise.resolve(fileStat()),
  )

  const readdirFn = vi.fn((filePath: string): Promise<string[]> => {
    if (filePath === SRC) {
      if (overrides.initialError !== undefined) {
        return Promise.reject(overrides.initialError)
      }

      return Promise.resolve(overrides.initialEntries ?? ['a.js'])
    }

    return overrides.readdirFor?.(filePath) ?? Promise.resolve([])
  })

  const compiler = makeCompiler(ignore)
  const deps: Partial<WatcherDeps> = { watchFn, statFn, readdirFn }
  const watcher = new RecursiveWatcher(compiler, deps)

  watcher.on('add', (filePath) => events.push({ type: 'add', filePath }))
  watcher.on('change', (filePath) => events.push({ type: 'change', filePath }))
  watcher.on('unlink', (filePath) => events.push({ type: 'unlink', filePath }))
  watcher.on('error', (error) => errors.push(error))

  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

  await watcher.ready

  return {
    listener: async (event, fileName) => {
      rawListener(event, fileName)
      await flush()
    },
    watcher,
    events,
    errors,
    close,
    ready: watcher.ready,
  }
}

const typesOf = (harness: DepsHarness): string[] =>
  harness.events.map((event) => event.type)

const basenames = (harness: DepsHarness): string[] =>
  harness.events.map((event) => event.filePath.split(/[\\/]/).pop()!)

describe('RecursiveWatcher event classification', () => {
  it('ignores events without a file name', async () => {
    const harness = await createWatcher()

    await harness.listener('rename', null)

    expect(harness.events).toEqual([])
  })

  it('ignores paths matched by the ignore list', async () => {
    const harness = await createWatcher(['**/skipme/**'], {
      initialEntries: [],
    })

    await harness.listener('rename', 'skipme/a.js')

    expect(harness.events).toEqual([])
  })

  it('accepts buffer file names', async () => {
    const harness = await createWatcher()

    await harness.listener('change', Buffer.from('a.js'))

    expect(typesOf(harness)).toEqual(['change'])
  })

  it('emits change for tracked files on raw change events', async () => {
    const harness = await createWatcher()

    await harness.listener('change', 'a.js')

    expect(typesOf(harness)).toEqual(['change'])
  })

  it('skips raw change events for untracked paths', async () => {
    const harness = await createWatcher()

    await harness.listener('change', 'unknown.js')

    expect(harness.events).toEqual([])
  })

  it('classifies rename as add then change for the same file', async () => {
    const harness = await createWatcher()

    await harness.listener('rename', 'b.js')
    await harness.listener('rename', 'b.js')

    expect(typesOf(harness)).toEqual(['add', 'change'])
  })

  it('classifies a vanished file as unlink', async () => {
    let vanished = false
    const harness = await createWatcher([], {
      initialEntries: ['a.js'],
      statFor: (filePath) =>
        filePath.endsWith('b.js') && vanished
          ? Promise.reject(new Error('gone'))
          : Promise.resolve(fileStat()),
    })

    await harness.listener('rename', 'b.js')
    expect(typesOf(harness)).toEqual(['add'])

    vanished = true
    await harness.listener('rename', 'b.js')
    expect(typesOf(harness)).toEqual(['add', 'unlink'])
  })

  it('expands a vanished directory into unlinks for tracked children', async () => {
    const harness = await createWatcher(['**/deep/**'], {
      initialEntries: ['tmp/a.js', 'tmp/b.js', 'tmp/deep/c.js'],
      statFor: (filePath) =>
        /[\\/]tmp$/.test(filePath)
          ? Promise.reject(new Error('gone'))
          : Promise.resolve(fileStat()),
    })

    await harness.listener('rename', 'tmp')

    expect(typesOf(harness)).toEqual(['unlink', 'unlink'])
    expect(basenames(harness).sort()).toEqual(['a.js', 'b.js'])
  })

  it('scans a renamed directory, reporting new files only', async () => {
    const harness = await createWatcher(['**/skipme/**'], {
      initialEntries: ['bulk/known.js'],
      statFor: (filePath) =>
        /[\\/]bulk$/.test(filePath)
          ? Promise.resolve(dirStat())
          : Promise.resolve(fileStat()),
      readdirFor: (filePath) =>
        filePath.endsWith('bulk')
          ? Promise.resolve(['known.js', 'fresh.js', 'skipme/x.js'])
          : Promise.resolve([]),
    })

    await harness.listener('rename', 'bulk')

    expect(typesOf(harness)).toEqual(['add'])
    expect(basenames(harness)).toEqual(['fresh.js'])
  })

  it('scans directory contents with nested directories and vanished entries', async () => {
    const harness = await createWatcher(['**/skipme/**'], {
      initialEntries: [],
      statFor: (filePath) => {
        if (/[\\/]bulk$/.test(filePath) || filePath.endsWith('nested')) {
          return Promise.resolve(dirStat())
        }

        if (filePath.endsWith('gone.js')) {
          return Promise.reject(new Error('vanished'))
        }

        return Promise.resolve(fileStat())
      },
      readdirFor: (filePath) =>
        filePath.endsWith('bulk')
          ? Promise.resolve(['nested', 'gone.js', 'fresh.js', 'skipme/x.js'])
          : Promise.resolve([]),
    })

    await harness.listener('rename', 'bulk')

    expect(typesOf(harness)).toEqual(['add'])
    expect(basenames(harness)).toEqual(['fresh.js'])
    expect(harness.errors).toEqual([])
  })

  it('handles a directory scan whose readdir fails', async () => {
    const harness = await createWatcher([], {
      initialEntries: [],
      statFor: (filePath) =>
        /[\\/]bulk$/.test(filePath)
          ? Promise.resolve(dirStat())
          : Promise.resolve(fileStat()),
      readdirFor: (filePath) =>
        filePath.endsWith('bulk')
          ? Promise.reject(new Error('gone'))
          : Promise.resolve([]),
    })

    await harness.listener('rename', 'bulk')

    expect(harness.events).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('surfaces scan failures as errors (Error instances)', async () => {
    const harness = await createWatcher([], {
      initialError: new Error('scan boom'),
    })

    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0]!.message).toBe('scan boom')
  })

  it('wraps non-error scan failures into Errors', async () => {
    const harness = await createWatcher([], { initialError: 'string boom' })

    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0]!.message).toBe('string boom')
  })

  it('closes the underlying handle once', async () => {
    const harness = await createWatcher()

    await harness.watcher.close()

    expect(harness.close).toHaveBeenCalledOnce()
  })

  it('surfaces watch-handle failures instead of throwing', async () => {
    const errors: Error[] = []
    const compiler = makeCompiler()
    const watcher: SourceWatcher = new RecursiveWatcher(compiler, {
      watchFn: () => {
        throw new Error('watch unavailable')
      },
    })

    watcher.on('error', (error) => errors.push(error))
    await watcher.ready

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('watch unavailable')

    // the failure stub still closes cleanly
    await watcher.close()
  })
})
