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
  Plugin,
  Vinyl,
} from '../types.js'

// Config fields that must not invalidate the cache when they change.
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

const fileUid = (file: { path: string; base: string }): string =>
  relativeId(file.path, file.base)

export interface CompileCachePluginOptions {
  versionKey?: string
}

// File-level compile cache. A cache entry is invalidated by: a tool version
// change, a missing output directory, a config checksum change, a missing
// record, a changed mtime, or a changed `.env` pseudo-dependency value.
export function compileCachePlugin(options: CompileCachePluginOptions = {}): Plugin {
  const { versionKey = 'version' } = options

  return definePlugin('compile-cache', (api) => {
    const { compiler, hooks, store } = api

    // scope → path → sum
    let checksums: Record<string, Record<string, string>> = {}
    let compiled: Record<string, number> = {}
    let lastVersion: string | undefined
    let isOutputDirExist = true
    let isOptionsChanged = false

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

    const checkFileCached = (id: string, current: number, file: FileRef): boolean => {
      const last = compiled[id]

      compiled[id] = current
      store.compiled.upsert([[id, current]])

      if (
        lastVersion !== compiler.version ||
        !isOutputDirExist ||
        isOptionsChanged ||
        last === undefined
      ) {
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
    })

    hooks.on('clean', ({ expired }) => {
      removeCache(expired)
    })

    hooks.on('beforeCompile', () => {
      lastVersion = compiler.query<string | undefined>(versionKey, undefined)
      isOutputDirExist = existsSync(compiler.outputDir)
      isOptionsChanged = checkOptionsChanged()
    })

    hooks.on('afterCompile', () => {
      if (lastVersion !== compiler.version) {
        compiler.save(versionKey, compiler.version)
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
      },
    })
  })
}

interface CompileErrorLike {
  file?: string
}
