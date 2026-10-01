import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { compileCachePlugin } from '../../../src/plugins/compile-cache.js'
import { makePluginEnv, type PluginTestEnv } from '../../helpers/plugin-api.js'
import { makeFile } from '../../helpers/stream.js'
import type { VinylType } from '../../helpers/stream.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

interface Env extends PluginTestEnv {
  caps: Record<string, (...args: never[]) => unknown>
  srcFile: string
}

async function makeEnv(
  options: {
    compiled?: Record<string, number>
    version?: string
    envValues?: Record<string, string>
    graphNode?: unknown
    warmup?: boolean
    withOutput?: boolean
  } = {},
): Promise<Env> {
  root = await mkdtemp(path.join(tmpdir(), 'deltic-cache-'))
  const srcFile = path.join(root, 'a.js')
  await writeFile(srcFile, 'content')

  if (options.withOutput !== false) {
    await mkdir(path.join(root, 'dist'), { recursive: true })
  }

  const env = makePluginEnv({ env: options.envValues ?? { NAME: 'one' } })
  const compiler = env.compiler as unknown as {
    baseDir: string
    sourceDir: string
    outputDir: string
    version: string
    getGraphNode?: unknown
  }

  compiler.baseDir = root
  compiler.sourceDir = root
  compiler.outputDir = path.join(root, 'dist')
  compiler.version = options.version ?? '0.1.0'

  if (options.graphNode !== undefined) {
    compiler.getGraphNode = vi.fn(() => options.graphNode)
  }

  if (options.compiled !== undefined) {
    env.store.compiled.upsert(Object.entries(options.compiled))
    env.store.flush()
  }

  if (options.version !== undefined) {
    env.state.set('version', options.version)
  }

  await compileCachePlugin().setup(env.api)
  await env.hooks.fire('init', { compiler: env.compiler as never })

  // Warm-up passes so the config checksum snapshot stabilizes before assertions.
  if (options.warmup !== false) {
    await env.hooks.fire('beforeCompile', { session: {} as never })
    await env.hooks.fire('beforeCompile', { session: {} as never })
  }

  return {
    ...env,
    caps: env.capabilities as Record<string, (...args: never[]) => unknown>,
    srcFile,
  }
}

function callCheck(env: Env, file: VinylType): boolean {
  return (env.caps.checkFileCached as (
    id: string,
    mtimeMs: number,
    file: VinylType,
  ) => boolean)(path.sep + path.basename(file.path), 111, file)
}

function cacheFile(stat = true): VinylType {
  const file = makeFile(path.join(root!, 'a.js'), 'content', root!)
  ;(file as { stat: unknown }).stat = stat ? { mtimeMs: 111 } : null
  file.context = {
    session: { totalCache: 0, totalHit: 0, files: [] },
  } as never

  return file
}

async function touch(file: string): Promise<void> {
  const fs = await import('node:fs/promises')
  const { atime, mtime } = await fs.stat(file)

  await utimes(file, atime, new Date(mtime.getTime() + 5000))
}

describe('compile-cache plugin', () => {
  it('caches a file whose mtime, options and env are unchanged', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
      version: '0.1.0',
    })

    const file = cacheFile()

    expect(callCheck(env, file)).toBe(true)
  })

  it('invalidates on the first run because no version is recorded', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
    })


    expect(callCheck(env, cacheFile())).toBe(false)
  })

  it('invalidates when the output directory is missing', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
      version: '0.1.0',
      withOutput: false,
    })


    expect(callCheck(env, cacheFile())).toBe(false)
  })

  it('caches when a matching record exists', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
      version: '0.1.0',
    })


    expect(callCheck(env, cacheFile())).toBe(true)
  })

  it('invalidates on a stale mtime record', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 999 },
      version: '0.1.0',
    })


    expect(callCheck(env, cacheFile())).toBe(false)

    await touch(env.srcFile)
  })

  it('invalidates when the options checksum changed', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
      version: '0.1.0',
    })

    // Change a checksummed option and re-evaluate.
    ;(env.compiler as unknown as { options: { alias: Record<string, string> } })
      .options.alias = { changed: 'yes' }
    await env.hooks.fire('beforeCompile', { session: {} as never })


    expect(callCheck(env, cacheFile())).toBe(false)
  })

  it('invalidates when there is no record for the file', async () => {
    const env = await makeEnv({ version: '0.1.0' })


    expect(callCheck(env, cacheFile())).toBe(false)
  })

  it('invalidates when an .env pseudo dependency changed', async () => {
    const envId = path.sep + path.join('.env', 'NAME')
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 111 },
      version: '0.1.0',
      envValues: { NAME: 'one' },
      graphNode: {
        path: path.sep + 'a.js',
        dependencies: [envId],
        requiredBy: [],
      },
    })
    env.state.set('env', { NAME: 'one' })


    expect(callCheck(env, cacheFile())).toBe(true)

    // env value changed in the resolved options
    ;(env.compiler as unknown as { options: { env: Record<string, string> } })
      .options.env = { NAME: 'two' }
    await env.hooks.fire('beforeCompile', { session: {} as never })

    expect(callCheck(env, cacheFile())).toBe(false)
  })

  it('removeCache accepts strings, files and arrays', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 1, [path.sep + 'b.js']: 2 },
      version: '0.1.0',
    })

    const removeCache = env.caps.removeCache as (
      files: string | VinylType | Array<string | VinylType>,
    ) => void

    removeCache(path.join(root!, 'a.js'))
    removeCache(makeFile(path.join(root!, 'b.js'), '', root!))
    env.store.flush()

    expect(env.store.compiled.all()).toEqual({})
  })

  it('removeCache ignores unknown files', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 1 },
      version: '0.1.0',
    })

    const removeCache = env.caps.removeCache as (files: string) => void

    removeCache(path.join(root!, 'unknown.js'))
    env.store.flush()

    expect(env.store.compiled.all()).toEqual({ [path.sep + 'a.js']: 1 })
  })

  it('taskError removes the cache of the failing file', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 1 },
      version: '0.1.0',
    })

    await env.hooks.fire('taskError', {
      error: { file: path.join(root!, 'a.js') },
    })
    env.store.flush()

    expect(env.store.compiled.all()).toEqual({})
  })

  it('taskError without a file payload is a no-op', async () => {
    const env = await makeEnv({
      compiled: { [path.sep + 'a.js']: 1 },
      version: '0.1.0',
    })

    await expect(
      env.hooks.fire('taskError', { error: new Error('plain') }),
    ).resolves.toBeUndefined()

    env.store.flush()

    expect(env.store.compiled.all()).toEqual({ [path.sep + 'a.js']: 1 })
  })

  it('checkFileChanged stores checksums with namespaces', async () => {
    const env = await makeEnv({ version: '0.1.0' })

    const check = env.caps.checkFileChanged as (
      f: VinylType,
      settings?: {
        namespace?: string | ((f: VinylType) => string)
        algorithm?: string
      },
    ) => { changed: boolean; checksum: string }

    const file = cacheFile()

    const first = check(file, { namespace: 'npmDeps', algorithm: 'md5' })
    expect(first.changed).toBe(true)
    expect(first.checksum).toMatch(/^[a-f0-9]{32}$/)

    const second = check(file, { namespace: 'npmDeps', algorithm: 'md5' })
    expect(second.changed).toBe(false)
    expect(second.checksum).toBe(first.checksum)

    const fnNs = check(file, { namespace: (f) => f.path })
    expect(fnNs.changed).toBe(true)

    env.store.flush()

    const stored = env.store.checksums.all()

    expect(Object.keys(stored)).toContain('npmDeps')
  })

  it('queues compiled records until flush', async () => {
    const env = await makeEnv({ version: '0.1.0' })

    callCheck(env, cacheFile())

    expect(env.store.compiled.all()).toEqual({})

    env.store.flush()

    expect(Object.keys(env.store.compiled.all())).toHaveLength(1)
  })

})
