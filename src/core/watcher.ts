import chokidar, { type FSWatcher } from 'chokidar'

import { debounce, type Debounced } from '../utils/timing.js'
import type { Compiler } from '../compiler.js'

type WatchEventType = 'add' | 'change' | 'unlink'

const ENV_PATTERN = /(^|[/\\])\.env(\..+)?$/

export interface WatchHandlers {
  record(path: string, type: WatchEventType): void
  flush(): void
}

// Buffers events and, after `watch.debounceMs` of silence, dispatches one
// incremental compile plus one cleanup. Per path the LAST event in a burst
// wins; `unlink` routes to the clean path instead.
export function createWatchHandlers(compiler: Compiler): WatchHandlers {
  const { options, logger } = compiler
  const buffer: Array<{ path: string; type: WatchEventType }> = []
  const cleanSpec = compiler.capability('cleanSpec')

  const flush: Debounced<[]> = debounce(options.watch.debounceMs, () => {
    const latest = new Map<string, WatchEventType>()

    for (const { path, type } of buffer.splice(0)) {
      latest.set(path, type)
    }

    const compilePaths: string[] = []
    const unlinkPaths: string[] = []

    for (const [path, type] of latest) {
      if (type === 'unlink') {
        unlinkPaths.push(path)
      } else {
        compilePaths.push(path)
      }
    }

    if (compilePaths.length > 0) {
      compiler.incrementCompile(compilePaths).catch((error: unknown) => {
        logger.error(error instanceof Error ? error.message : String(error))
      })
    }

    if (unlinkPaths.length > 0 && cleanSpec !== undefined) {
      compiler
        .schedule(async () => {
          const expired = await cleanSpec(unlinkPaths)
          await compiler.fire('clean', { expired })
        })
        .catch((error: unknown) => {
          logger.error(error instanceof Error ? error.message : String(error))
        })
    }
  }, options.timer)

  return {
    record: (path, type) => {
      buffer.push({ path, type })
      flush()
    },
    flush: () => flush.flush(),
  }
}

export function watchSource(compiler: Compiler): FSWatcher {
  const { options, logger, sourceDir } = compiler
  const handlers = createWatchHandlers(compiler)

  const watcher = chokidar.watch(sourceDir, {
    ignoreInitial: true,
    ignored: [...options.ignore, ENV_PATTERN],
    ...options.watch.chokidar,
  })

  watcher.on('add', (path) => {
    logger.info(`${path} was added`)
    handlers.record(path, 'add')
  })
  watcher.on('change', (path) => {
    logger.info(`${path} was changed`)
    handlers.record(path, 'change')
  })
  watcher.on('unlink', (path) => {
    handlers.record(path, 'unlink')
  })
  watcher.on('error', (error) => {
    logger.error(String(error))
  })

  logger.info(`watching ${sourceDir}`)

  const ready = new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve())
  })

  return Object.assign(watcher, { ready })
}
