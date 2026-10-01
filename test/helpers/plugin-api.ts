import path from 'node:path'
import { vi } from 'vitest'

import { HookRegistryImpl } from '../../src/core/hooks.js'
import { SqliteState } from '../../src/store/sqlite-state.js'
import type { Logger } from '../../src/utils/logger.js'
import type { PluginContext } from '../../src/types.js'
import { createManualTimer, type ManualTimer } from './timer.js'

export interface PluginTestEnv {
  api: PluginContext
  hooks: HookRegistryImpl
  capabilities: Record<string, unknown>
  /** Real SQLite state on ':memory:' — seed via the store, then flush(). */
  store: SqliteState
  /** In-memory meta kv backing compiler.query/save (env snapshots, versions). */
  state: Map<string, unknown>
  timer: ManualTimer
  logger: Logger
  compiler: {
    baseDir: string
    sourceDir: string
    outputDir: string
    cacheDir: string
    version: string
    resolve(request: string, relativePath?: string): string
    [key: string]: unknown
  }
}

export function makePluginEnv(
  options: {
    env?: Record<string, string>
    alias?: Record<string, string>
  } = {},
): PluginTestEnv {
  const timer = createManualTimer()
  const state = new Map<string, unknown>()
  const capabilities: Record<string, unknown> = {}
  const hooks = new HookRegistryImpl()
  const store = new SqliteState({ file: ':memory:' })

  const baseDir = path.resolve('/project')
  const sourceDir = path.resolve(baseDir, 'src')
  const outputDir = path.resolve(baseDir, 'dist')

  const resolve = (request: string, relativePath?: string): string => {
    const pwd = relativePath === undefined ? sourceDir : path.dirname(relativePath)

    if (path.isAbsolute(request)) {
      return path.join(sourceDir, request)
    }

    if (request.startsWith('./') || request.startsWith('../')) {
      return path.resolve(pwd, request)
    }

    return path.resolve(sourceDir, request)
  }

  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const compiler = {
    options: {
      timer,
      logger,
      ignore: [],
      env: options.env ?? { NAME: 'one', OTHER: '2' },
      alias: options.alias ?? {},
    },
    baseDir,
    sourceDir,
    outputDir,
    cacheDir: path.resolve(baseDir, '.deltic'),
    version: '0.1.0',
    logger,
    resolve,
    query: (key: string, defaults: unknown) =>
      state.has(key) ? state.get(key) : defaults,
    save: (key: string, value: unknown) => {
      state.set(key, value)
    },
  }

  const api: PluginContext = {
    compiler: compiler as never,
    hooks,
    logger,
    store,
    registerPipe: vi.fn(),
    extendContext: vi.fn(
      (extension: { capabilities?: Record<string, unknown> }) => {
        Object.assign(capabilities, extension.capabilities)
      },
    ),
  }

  return {
    api,
    hooks,
    capabilities,
    store,
    state,
    timer,
    logger,
    compiler: compiler as PluginTestEnv['compiler'],
  }
}
