import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RecursiveWatcher,
  supportsRecursiveWatch,
  watchSource,
  type SourceWatcher,
} from '../../../src/core/watcher.js'
import type { Compiler } from '../../../src/compiler.js'
import type { Logger } from '../../../src/utils/logger.js'

let roots: string[] = []
let watcher: SourceWatcher | null = null

afterEach(async () => {
  await watcher?.close()
  watcher = null

  const pending = roots
  roots = []

  for (const root of pending) {
    await rm(root, { recursive: true, force: true, retryDelay: 200, maxRetries: 5 })
  }
})

interface Harness {
  srcDir: string
  events: Array<{ type: string; filePath: string }>
  write(relPath: string, content: string): Promise<void>
  mkdir(relPath: string): Promise<void>
  remove(relPath: string): Promise<void>
  settle(): Promise<void>
}

const createCompiler = (
  srcDir: string,
  ignore: string[] = [],
  chokidarOptions: Record<string, unknown> = {},
): Compiler =>
  ({
    sourceDir: srcDir,
    options: { ignore, watch: { debounceMs: 10, chokidar: chokidarOptions } },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    capability: () => undefined,
    incrementCompile: vi.fn(async () => {}),
    schedule: vi.fn(async (fn: () => Promise<void>) => fn()),
    fire: vi.fn(async () => {}),
  }) as unknown as Compiler

async function createHarness(
  ignore: string[] = [],
  chokidarOptions: Record<string, unknown> = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'deltic-watch-'))
  const srcDir = path.join(root, 'src')

  roots.push(root)
  await mkdir(srcDir, { recursive: true })

  const events: Array<{ type: string; filePath: string }> = []

  watcher = watchSource(createCompiler(srcDir, ignore, chokidarOptions))
  await watcher.ready

  watcher.on('add', (filePath) => events.push({ type: 'add', filePath }))
  watcher.on('change', (filePath) => events.push({ type: 'change', filePath }))
  watcher.on('unlink', (filePath) => events.push({ type: 'unlink', filePath }))

  return {
    srcDir,
    events,
    async write(relPath, content) {
      const target = path.join(srcDir, relPath)

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    },
    async mkdir(relPath) {
      await mkdir(path.join(srcDir, relPath), { recursive: true })
    },
    async remove(relPath) {
      await rm(path.join(srcDir, relPath), { recursive: true, force: true })
    },
    async settle(ms = 1000) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    },
  }
}

const waitForEvent = async (
  events: Array<{ type: string; filePath: string }>,
  type: string,
  suffix: string,
): Promise<void> => {
  const start = Date.now()

  while (Date.now() - start < 8000) {
    if (
      events.some(
        (event) => event.type === type && event.filePath.endsWith(suffix),
      )
    ) {
      return
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }

  throw new Error(`no ${type} event for ${suffix}`)
}

// watchSource picks the backend from process.platform, so the wiring tests
// have to observe both choices regardless of the host they run on.
const stubPlatform = <T>(platform: NodeJS.Platform, fn: () => T): T => {
  const real = process.platform

  Object.defineProperty(process, 'platform', { value: platform })

  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: real })
  }
}

// Real-file-system proof that the wired backends deliver events. The
// RecursiveWatcher contract itself is covered platform-independently —
// against injected fs and clock — by watcher.classifier.test.ts; what the
// tests below add is the real wiring:
//  - the recursive backend only exists where fs.watch has a recursive mode,
//    so its tests run on those platforms alone;
//  - the chokidar tests only write into the directory that existed before
//    the watcher started (its watch is attached before `ready`, so later
//    writes are always delivered). chokidar snapshots a NEW directory before
//    attaching its inotify watch, so files written into one during that
//    window can be dropped — chokidar's own timing, not the contract here.
describe('watchSource', () => {
  describe.skipIf(!supportsRecursiveWatch())('recursive backend', () => {
    it('reports added and changed files', async () => {
      const harness = await createHarness()

      await harness.write('js/a.js', 'one')
      await waitForEvent(harness.events, 'add', 'a.js')

      await harness.write('js/a.js', 'two')
      await waitForEvent(harness.events, 'change', 'a.js')
    }, 15000)

    it('reports deleted files', async () => {
      const harness = await createHarness()

      await harness.write('js/a.js', 'one')
      await waitForEvent(harness.events, 'add', 'a.js')

      await harness.remove('js/a.js')
      await waitForEvent(harness.events, 'unlink', 'a.js')
    }, 15000)

    it('expands a deleted directory into unlinks for its files', async () => {
      const harness = await createHarness()

      await harness.write('tmp/a.js', 'one')
      await harness.write('tmp/b.js', 'two')
      await waitForEvent(harness.events, 'add', 'a.js')
      await waitForEvent(harness.events, 'add', 'b.js')

      await harness.remove('tmp')

      await waitForEvent(harness.events, 'unlink', path.join('tmp', 'a.js'))
      await waitForEvent(harness.events, 'unlink', path.join('tmp', 'b.js'))
    }, 15000)

    it('ignores files matched by the ignore globs', async () => {
      const harness = await createHarness(['**/skipme/**'])

      await harness.write('skipme/a.js', 'one')
      await harness.write('keepme/a.js', 'two')

      await waitForEvent(harness.events, 'add', path.join('keepme', 'a.js'))
      await harness.settle()

      expect(
        harness.events.some((event) => event.filePath.includes('skipme')),
      ).toBe(false)
    }, 15000)

    it('scans files created inside a burst-added directory', async () => {
      const harness = await createHarness()

      await harness.mkdir('bulk')
      await harness.write('bulk/a.js', 'one')
      await harness.write('bulk/b.js', 'two')

      await waitForEvent(harness.events, 'add', path.join('bulk', 'a.js'))
      await waitForEvent(harness.events, 'add', path.join('bulk', 'b.js'))
    }, 15000)
  })

  it('delivers add, change and unlink through the chokidar backend', async () => {
    const harness = await createHarness([], { ignoreInitial: true })

    await harness.write('a.js', 'one')
    await waitForEvent(harness.events, 'add', 'a.js')

    await harness.write('a.js', 'two')
    await waitForEvent(harness.events, 'change', 'a.js')

    await harness.remove('a.js')
    await waitForEvent(harness.events, 'unlink', 'a.js')
  }, 15000)

  it('selects the recursive backend where fs.watch is recursive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'deltic-watch-'))
    const srcDir = path.join(root, 'src')

    roots.push(root)
    await mkdir(srcDir, { recursive: true })

    watcher = stubPlatform('darwin', () => watchSource(createCompiler(srcDir)))
    await watcher.ready

    expect(watcher).toBeInstanceOf(RecursiveWatcher)
  }, 15000)

  it('selects the chokidar backend where fs.watch is not recursive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'deltic-watch-'))
    const srcDir = path.join(root, 'src')

    roots.push(root)
    await mkdir(srcDir, { recursive: true })

    watcher = stubPlatform('linux', () => watchSource(createCompiler(srcDir)))
    await watcher.ready

    expect(watcher).not.toBeInstanceOf(RecursiveWatcher)
  }, 15000)

  it('selects the chokidar backend when chokidar options are passed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'deltic-watch-'))
    const srcDir = path.join(root, 'src')

    roots.push(root)
    await mkdir(srcDir, { recursive: true })

    watcher = stubPlatform('darwin', () =>
      watchSource(createCompiler(srcDir, [], { ignoreInitial: true })),
    )
    await watcher.ready

    expect(watcher).not.toBeInstanceOf(RecursiveWatcher)
  }, 15000)
})
