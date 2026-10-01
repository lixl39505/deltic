import { readdir, rm, rmdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import fastGlob from 'fast-glob'

import { dedup, groupBy } from '../utils/array.js'
import { joinGlob, toGlobPath } from '../utils/paths.js'
import { definePlugin } from './define-plugin.js'
import { relativeId } from './dep-graph.js'
import type { CleanCapabilities, Plugin } from '../types.js'

// Output hygiene driven by actual emission records: every task pipeline
// records the files dest writes (session.outputs, attributed to their source
// via originalPath), and this plugin removes exactly those records when the
// source disappears — no glob guessing, so one-to-many producers (e.g. SFC
// slices under a per-component directory) are cleaned precisely.
export function cleanPlugin(): Plugin {
  return definePlugin('clean', (api) => {
    const { compiler, hooks, logger, store } = api

    let fileList: string[] = []
    // source id → emitted output paths
    let outputs: Record<string, string[]> = {}

    const removeFiles = async (paths: readonly string[]): Promise<void> => {
      for (const filePath of paths) {
        await rm(filePath, { force: true })
        logger.info(`${filePath} was deleted`)
      }
    }

    // Removes now-empty directories above deleted outputs, stopping at the
    // output directory itself.
    const pruneEmptyDirs = async (startDir: string): Promise<void> => {
      const stop = path.resolve(compiler.outputDir)
      let current = path.resolve(startDir)

      for (;;) {
        const rel = path.relative(stop, current)

        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          return
        }

        let entries: Dirent[]

        try {
          entries = await readdir(current, { withFileTypes: true })
        } catch {
          return
        }

        if (entries.length > 0) {
          return
        }

        await rmdir(current)
        current = path.dirname(current)
      }
    }

    const dropOutputs = async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        const recorded = outputs[id]

        if (recorded === undefined) {
          continue
        }

        await removeFiles(recorded)

        for (const filePath of recorded) {
          await pruneEmptyDirs(path.dirname(filePath))
        }

        delete outputs[id]
      }

      store.outputs.remove(ids)
    }

    const cleanExpired = async (): Promise<string[]> => {
      const current = fastGlob.sync([joinGlob(compiler.sourceDir, '**')], {
        ignore: compiler.options.ignore,
      })

      const expired = fileList.filter((item) => !current.includes(item))
      const added = current.filter((item) => !fileList.includes(item))

      if (expired.length === 0) {
        if (added.length > 0) {
          store.files.add(added)
        }

        fileList = current
        return []
      }

      await dropOutputs(expired.map((item) => relativeId(item, compiler.sourceDir)))

      if (added.length > 0) {
        store.files.add(added)
      }

      store.files.remove(expired)
      fileList = current

      return expired
    }

    const cleanSpec = async (
      paths: string | readonly string[],
    ): Promise<string[]> => {
      const list = typeof paths === 'string' ? [paths] : [...paths]

      for (const item of list) {
        // fast-glob lists sources with forward slashes; watcher events arrive
        // with platform separators — canonicalize before comparing.
        const resolved = toGlobPath(path.resolve(compiler.baseDir, item))

        await dropOutputs([relativeId(resolved, compiler.sourceDir)])

        const index = fileList.indexOf(resolved)

        if (index >= 0) {
          fileList.splice(index, 1)
          store.files.remove([resolved])
        }
      }

      return list
    }

    hooks.on('init', () => {
      fileList = store.files.all()
      outputs = store.outputs.all()
    })

    hooks.on('afterCompile', async ({ session }) => {
      if (session.outputs.length === 0) {
        return
      }

      const grouped = groupBy(session.outputs, (output) => output.source)

      for (const [source, items] of Object.entries(grouped)) {
        const id = relativeId(source, compiler.sourceDir)
        const next = dedup(items.map((item) => item.path))
        const previous = outputs[id] ?? []
        // A config change can rename outputs: drop files this run no longer
        // writes so stale artifacts never outlive their record.
        const vanished = previous.filter((filePath) => !next.includes(filePath))

        outputs[id] = next
        store.outputs.upsert([[id, next]])

        if (vanished.length > 0) {
          await removeFiles(vanished)
        }
      }
    })

    api.extendContext({
      capabilities: {
        isNewFile: (filePath: string) => !fileList.includes(filePath),
        cleanExpired,
        cleanSpec,
        saveFileList: () => {
          store.files.add(fileList)
        },
      } satisfies CleanCapabilities,
    })
  })
}
