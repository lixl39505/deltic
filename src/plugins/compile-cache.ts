import { existsSync } from 'node:fs'
import path from 'node:path'

import { checksum } from '../utils/hash.js'
import { definePlugin } from './define-plugin.js'
import { relativeId } from './dep-graph.js'
import type {
  CheckFileChangedResult,
  CheckFileChangedSettings,
  CompileCacheCapabilities,
  DepNode,
  FileRef,
  NormalizedTaskConfig,
  Plugin,
  Vinyl,
} from '../types.js'

// Config fields that must not invalidate the cache when they change. `tasks`
// is excluded because task configs get their own finer-grained checksums: a
// file's cache verdict is bound to the checksum of the task that compiles it,
// so changing one task never invalidates unrelated file types.
const CHECKSUM_EXCLUDED_FIELDS = new Set([
  'env',
  'mode',
  'config',
  'source',
  'sourceDir',
  'output',
  'outputDir',
  'cacheDir',
  'baseDir',
  'ignore',
  'tasks',
  'watch',
  'logger',
  'timer',
  'profile',
])

// Checksums without an explicit namespace live under this scope.
const ROOT_SCOPE = '@'

// Per-task config checksums live under this scope, keyed by task name.
const TASK_SCOPE = 'task'

const fileUid = (file: { path: string; base: string }): string =>
  relativeId(file.path, file.base)

export interface CompileCachePluginOptions {
  versionKey?: string
  /**
   * Extra invalidation inputs, evaluated once per run. Snapshots are persisted
   * and compared item-by-item (shallow equality): any difference invalidates
   * the whole cache. Use it to tie cache validity to embedder state such as a
   * toolchain version.
   */
  extraDeps?: () => readonly unknown[]
}

const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true
  }

  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false
  }

  const record = a as Record<string, unknown>
  const keys = Object.keys(record)
  const other = b as Record<string, unknown>

  if (keys.length !== Object.keys(other).length) {
    return false
  }

  return keys.every((key) => Object.is(record[key], other[key]))
}

const depsChanged = (
  prev: readonly unknown[] | undefined,
  next: readonly unknown[],
): boolean =>
  prev === undefined ||
  prev.length !== next.length ||
  next.some((value, index) => !shallowEqual(prev[index], value))

const serializeTask = (task: NormalizedTaskConfig): string =>
  JSON.stringify(task, (_key, value: unknown) =>
    typeof value === 'function' ? value.toString() : value,
  )

// File-level compile cache. A cache entry is invalidated by: a tool version
// change, a missing output directory, a config checksum change, an extra-deps
// change, a changed checksum of the owning task's config, a missing record, a
// changed mtime, or a changed `.env` pseudo-dependency value.
export function compileCachePlugin(options: CompileCachePluginOptions = {}): Plugin {
  const { versionKey = 'version', extraDeps } = options

  return definePlugin('compile-cache', (api) => {
    const { compiler, hooks, store } = api

    // scope → path → sum
    let checksums: Record<string, Record<string, string>> = {}
    let compiled: Record<string, number> = {}
    let taskSums: Record<string, string> = {}
    let lastVersion: string | undefined
    let isOutputDirExist = true
    let isOptionsChanged = false
    let isDepsChanged = false
    let pendingDeps: readonly unknown[] | undefined
    const currentTaskSums = new Map<string, string>()

    const removeCache = (
      files: string | Vinyl | readonly (string | Vinyl)[],
    ): void => {
      const list: Array<string | Vinyl> = Array.isArray(files)
        ? [...files]
        : [files]

      const ids: string[] = []

      for (const item of list) {
        const id =
          typeof item === 'string'
            ? relativeId(item, compiler.sourceDir)
            : fileUid(item)

        if (compiled[id] !== undefined) {
          delete compiled[id]
          ids.push(id)
        }
      }

      if (ids.length > 0) {
        store.compiled.remove(ids)
        store.checksums.removePaths(ids)
      }
    }

    const checkFileChanged = (
      file: Vinyl,
      settings?: CheckFileChangedSettings,
    ): CheckFileChangedResult => {
      const namespace = settings?.namespace
      const algorithm = settings?.algorithm ?? 'sha1'
      const scope =
        namespace === undefined
          ? ROOT_SCOPE
          : typeof namespace === 'function'
            ? namespace(file)
            : namespace

      const bucket = (checksums[scope] ??= {})

      const key = path.relative(compiler.baseDir, file.path)
      const sum = checksum((file.contents as Buffer).toString('utf8'), algorithm)

      if (bucket[key] === sum) {
        return { changed: false, checksum: sum }
      }

      bucket[key] = sum
      store.checksums.upsert(scope, [[key, sum]])

      return { changed: true, checksum: sum }
    }

    const checkOptionsChanged = (): boolean => {
      const filtered: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(compiler.options)) {
        if (!CHECKSUM_EXCLUDED_FIELDS.has(key)) {
          filtered[key] = value
        }
      }

      const serialized = JSON.stringify(filtered, (_key, value: unknown) =>
        typeof value === 'function' ? value.toString() : value,
      )

      return checkFileChanged({
        path: path.join(compiler.baseDir, 'config'),
        contents: Buffer.from(serialized),
      } as Vinyl).changed
    }

    const isTaskChecksumCurrent = (taskName: string): boolean => {
      let sum = currentTaskSums.get(taskName)

      if (sum === undefined) {
        const task = compiler.options.tasks[taskName]

        if (task === undefined) {
          return false
        }

        sum = checksum(serializeTask(task), 'sha1')
        currentTaskSums.set(taskName, sum)
      }

      if (taskSums[taskName] === sum) {
        return true
      }

      taskSums[taskName] = sum
      store.checksums.upsert(TASK_SCOPE, [[taskName, sum]])

      return false
    }

    const checkFileCached = (
      id: string,
      current: number,
      file: FileRef,
      taskName: string,
    ): boolean => {
      const last = compiled[id]

      compiled[id] = current
      store.compiled.upsert([[id, current]])

      // Evaluate (and persist) the task checksum before the global gates:
      // a full-miss run must still record the sums, or the next run would
      // invalidate everything again for one extra cycle.
      const taskCurrent = isTaskChecksumCurrent(taskName)

      if (
        lastVersion !== compiler.version ||
        !isOutputDirExist ||
        isOptionsChanged ||
        isDepsChanged ||
        last === undefined
      ) {
        return false
      }

      if (!taskCurrent) {
        return false
      }

      if (last !== current) {
        return false
      }

      // `.env/X` pseudo-dependencies tie cache validity to env values.
      const lastEnv = compiler.query<Record<string, string>>('env', {})
      const currentEnv = compiler.options.env
      const getGraphNode = (
        compiler as unknown as {
          getGraphNode?: (file: FileRef) => DepNode | undefined
        }
      ).getGraphNode
      const node = getGraphNode?.(file)

      if (
        node?.dependencies.some((dep) => {
          const name = dep.split(path.sep).pop()!

          return (
            dep.startsWith(`${path.sep}.env`) &&
            lastEnv[name] !== undefined &&
            String(lastEnv[name]) !== String(currentEnv[name])
          )
        }) === true
      ) {
        return false
      }


      return true
    }

    hooks.on('init', () => {
      checksums = store.checksums.all()
      compiled = store.compiled.all()
      taskSums = store.checksums.all()[TASK_SCOPE] ?? {}
    })

    hooks.on('clean', ({ expired }) => {
      removeCache(expired)
    })

    hooks.on('beforeCompile', () => {
      lastVersion = compiler.query<string | undefined>(versionKey, undefined)
      isOutputDirExist = existsSync(compiler.outputDir)
      isOptionsChanged = checkOptionsChanged()
      currentTaskSums.clear()

      if (extraDeps === undefined) {
        isDepsChanged = false
        pendingDeps = undefined
        return
      }

      pendingDeps = extraDeps()
      isDepsChanged = depsChanged(
        store.meta.get<readonly unknown[] | undefined>('extraDeps', undefined),
        pendingDeps,
      )
    })

    hooks.on('afterCompile', () => {
      if (lastVersion !== compiler.version) {
        compiler.save(versionKey, compiler.version)
      }

      if (pendingDeps !== undefined) {
        store.meta.set('extraDeps', [...pendingDeps])
        pendingDeps = undefined
      }
    })

    hooks.on('taskError', ({ error }) => {
      const file = (error as CompileErrorLike).file

      if (typeof file === 'string') {
        removeCache(file)
      }
    })

    api.extendContext({
      capabilities: {
        checkFileCached,
        checkFileChanged,
        removeCache,
      } satisfies CompileCacheCapabilities,
    })
  })
}

interface CompileErrorLike {
  file?: string
}
