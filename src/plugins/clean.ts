import { rm } from 'node:fs/promises'
import path from 'node:path'

import fastGlob from 'fast-glob'

import { escapeGlobLiteral, joinGlob, stripBase, toGlobPath } from '../utils/paths.js'
import { definePlugin } from './define-plugin.js'
import type { Plugin } from '../types.js'

async function removeGlobs(
  globs: string[],
  cwd: string,
  onDelete: (deleted: string) => void,
): Promise<number> {
  // globs are absolute, so matches come back absolute
  const matches = fastGlob.sync(globs, { cwd })

  for (const match of matches) {
    await rm(match, { recursive: true, force: true })
    onDelete(match)
  }

  return matches.length
}

// Output hygiene: tracks the source file list and removes stale artifacts
// for files that disappeared from the source tree.
export function cleanPlugin(): Plugin {
  return definePlugin('clean', (api) => {
    const { compiler, hooks, logger, store } = api

    let fileList: string[] = []

    const getOutputPath = (paths: string | readonly string[]): string[] => {
      const list = typeof paths === 'string' ? [paths] : [...paths]
      const { baseDir, sourceDir, outputDir } = compiler

      return list.map((rawPath) => {
        const filePath = path.resolve(baseDir, rawPath)
        const extname = path.extname(filePath)
        const basename = path.basename(filePath, extname)
        // stripBase survives Windows casing drift; raw String.replace did not
        const dirname = path.dirname(
          path.join(outputDir, stripBase(filePath, sourceDir)),
        )

        return joinGlob(dirname, `${escapeGlobLiteral(basename)}.*`)
      })
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

      await removeGlobs(getOutputPath(expired), compiler.baseDir, (deleted) => {
        logger.info(`${deleted} was deleted`)
      })

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

      await removeGlobs(getOutputPath(list), compiler.baseDir, (deleted) => {
        logger.info(`${deleted} was deleted`)
      })

      const removed: string[] = []

      for (const item of list) {
        // fast-glob lists sources with forward slashes; watcher events arrive
        // with platform separators — canonicalize before comparing.
        const resolved = toGlobPath(path.resolve(compiler.baseDir, item))
        const index = fileList.indexOf(resolved)

        if (index >= 0) {
          fileList.splice(index, 1)
          removed.push(resolved)
        }
      }

      if (removed.length > 0) {
        store.files.remove(removed)
      }

      return list
    }

    hooks.on('init', () => {
      fileList = store.files.all()
    })

    api.extendContext({
      capabilities: {
        isNewFile: (filePath: string) => !fileList.includes(filePath),
        cleanExpired,
        cleanSpec,
        getOutputPath,
        saveFileList: () => {
          store.files.add(fileList)
        },
      },
    })
  })
}
