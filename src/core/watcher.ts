import { EventEmitter } from 'node:events'
import {
  watch as fsWatch,
  type FSWatcher as NodeFsWatcher,
  type Stats,
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import chokidar from 'chokidar'

import { debounce, type Debounced } from '../utils/timing.js'
import { createIgnoreMatcher, type IgnoreMatcher } from '../utils/ignore.js'
import type { Compiler } from '../compiler.js'

type WatchEventType = 'add' | 'change' | 'unlink'

const ENV_PATTERN = /(^|[/\\])\.env(\..+)?$/

export interface SourceWatcher {
  on(event: WatchEventType, listener: (filePath: string) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'ready', listener: () => void): unknown
  emit(event: 'error', error: Error): boolean
  close(): Promise<void>
  /** Resolves once the initial scan finished and events start flowing. */
  ready: Promise<void>
}

export interface WatchHandlers {
  record(path: string, type: WatchEventType): void
  flush(): void
}

// A dev session can touch thousands of paths, so the replay bookkeeping is
// capped: the oldest entry is dropped once the map grows past this size.
const MAX_RECENT_EVENTS = 512

// Buffers events and, after `watch.debounceMs` of silence, dispatches one
// incremental compile plus one cleanup. Per path the LAST event in a burst
// wins; `unlink` routes to the clean path instead. Logging happens here, once
// per path, so the output matches the compile batch instead of the raw fs
// event stream.
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

    for (const [filePath, type] of latest) {
      if (type === 'unlink') {
        unlinkPaths.push(filePath)
      } else {
        logger.info(`${filePath} was ${type === 'add' ? 'added' : 'changed'}`)
        compilePaths.push(filePath)
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

// Recursive fs.watch keeps the whole tree under ONE descriptor: macOS kqueue
// burns one fd per watched directory (default soft limit 256 — a few hundred
// source dirs plus compile-time fds overflow it with EMFILE), so darwin and
// win32 use the native recursive backend and event classification below.
// Linux fs.watch has no recursive support and inotify watch descriptors are
// not fds, so chokidar stays the backend there (and whenever the user passes
// chokidar options).
const RECURSIVE_WATCH_PLATFORMS = new Set(['darwin', 'win32'])

// FSEvents reports one physical write twice for the same path (the entry that
// is replaced and the one that appears), and libuv maps both to 'rename'.
// Replays land within the same millisecond, so identical events for one path
// inside this window are collapsed; anything slower is a real edit.
const EVENT_REPLAY_WINDOW_MS = 100

const canWatchRecursively = (compiler: Compiler): boolean =>
  RECURSIVE_WATCH_PLATFORMS.has(process.platform) &&
  Object.keys(compiler.options.watch.chokidar).length === 0

// Injectable fs operations: tests drive event classification deterministically
// without touching the real file system.
export interface WatcherDeps {
  watchFn(
    path: string,
    options: { recursive: boolean },
    listener: (event: string, fileName: string | Buffer | null) => void,
  ): NodeFsWatcher
  statFn(path: string): Promise<Stats>
  readdirFn(path: string, options: { recursive: boolean }): Promise<string[]>
  nowFn(): number
}

export class RecursiveWatcher extends EventEmitter implements SourceWatcher {
  readonly ready: Promise<void>

  readonly #compiler: Compiler
  readonly #deps: WatcherDeps
  readonly #isIgnored: IgnoreMatcher
  readonly #handle: NodeFsWatcher
  readonly #liveFiles = new Set<string>()
  readonly #liveDirs = new Set<string>()
  readonly #recentEvents = new Map<string, number>()
  #scanChain: Promise<void> = Promise.resolve()

  constructor(compiler: Compiler, deps: Partial<WatcherDeps> = {}) {
    super()
    this.#compiler = compiler
    this.#deps = {
      watchFn: fsWatch,
      statFn: stat,
      readdirFn: readdir,
      nowFn: Date.now,
      ...deps,
    }
    this.#isIgnored = createIgnoreMatcher([
      ...compiler.options.ignore,
      ENV_PATTERN,
    ])

    try {
      this.#handle = this.#deps.watchFn(
        compiler.sourceDir,
        { recursive: true },
        this.#onFsEvent,
      )
    } catch (error) {
      // fs.watch throws synchronously on a missing root (Windows) — surface
      // it like chokidar does instead of crashing the compiler constructor.
      // Deferred so the caller can attach an error listener post-construction.
      this.#handle = { close: () => {} } as unknown as NodeFsWatcher
      this.ready = Promise.resolve()
      queueMicrotask(() => {
        this.#emitError(error)
      })
      return
    }

    this.ready = this.#initialScan().then(() => {
      this.emit('ready')
    })
  }

  close(): Promise<void> {
    this.#handle.close()
    return Promise.resolve()
  }

  #emitError = (error: unknown): void => {
    this.emit('error', error instanceof Error ? error : new Error(String(error)))
  }

  // Replay guard: drop an event identical to the one just emitted for the same
  // path. A change followed by an unlink (or an add followed by a change) is a
  // different type and always goes through.
  #emit(type: WatchEventType, filePath: string): void {
    const now = this.#deps.nowFn()
    const key = `${type}\u0000${filePath}`
    const last = this.#recentEvents.get(key)

    if (last !== undefined && now - last < EVENT_REPLAY_WINDOW_MS) {
      return
    }

    // re-insert so iteration order tracks the most recent emission
    this.#recentEvents.delete(key)
    this.#recentEvents.set(key, now)

    if (this.#recentEvents.size > MAX_RECENT_EVENTS) {
      this.#recentEvents.delete(this.#recentEvents.keys().next().value as string)
    }

    this.emit(type, filePath)
  }

  #onFsEvent = (event: string, fileName: string | Buffer | null): void => {
    // FSEvents can coalesce bursts into directory-level events without a
    // name; the affected files re-report on their next mutation.
    if (fileName === null) {
      return
    }

    const filePath = path.resolve(
      this.#compiler.sourceDir,
      fileName.toString(),
    )

    if (this.#isIgnored(filePath)) {
      return
    }

    if (event === 'change') {
      // A change for an untracked path arrives as a rename as well; let the
      // rename branch classify it so it is never compiled twice.
      if (this.#liveFiles.has(filePath)) {
        this.#emit('change', filePath)
      }

      return
    }

    // rename: create, delete, atomic-save swap, or directory churn
    void this.#deps.statFn(filePath).then(
      (fileStat) => {
        if (fileStat.isDirectory()) {
          this.#trackDirectory(filePath)
          return
        }

        if (this.#liveFiles.has(filePath)) {
          this.#emit('change', filePath)
          return
        }

        this.#liveFiles.add(filePath)
        this.#emit('add', filePath)
      },
      () => {
        this.#forgetPath(filePath)
      },
    )
  }

  // A vanished directory may take tracked files with it in one coalesced
  // event (FSEvents especially): expand the delete to everything under it.
  #forgetPath(filePath: string): void {
    const prefix = `${filePath}${path.sep}`

    for (const tracked of [...this.#liveFiles]) {
      if (tracked === filePath || tracked.startsWith(prefix)) {
        this.#liveFiles.delete(tracked)
        this.#emit('unlink', tracked)
      }
    }

    for (const tracked of [...this.#liveDirs]) {
      if (tracked === filePath || tracked.startsWith(prefix)) {
        this.#liveDirs.delete(tracked)
      }
    }
  }

  // Directories created in one burst (git checkout) arrive as a single
  // directory-level rename: scan them so inner files are not missed.
  #trackDirectory(filePath: string): void {
    this.#liveDirs.add(filePath)
    this.#scanChain = this.#scanChain.then(async () => {
      let entries: string[]

      try {
        entries = await this.#deps.readdirFn(filePath, { recursive: true })
      } catch {
        this.#forgetPath(filePath)
        return
      }

      for (const entry of entries) {
        const entryPath = path.resolve(filePath, entry)

        if (this.#isIgnored(entryPath)) {
          continue
        }

        try {
          const entryStat = await this.#deps.statFn(entryPath)

          if (entryStat.isDirectory()) {
            this.#liveDirs.add(entryPath)
            continue
          }

          if (this.#liveFiles.has(entryPath)) {
            continue
          }

          this.#liveFiles.add(entryPath)
          this.#emit('add', entryPath)
        } catch {
          this.#forgetPath(entryPath)
        }
      }
    })
  }

  async #initialScan(): Promise<void> {
    let entries: string[]

    try {
      entries = await this.#deps.readdirFn(this.#compiler.sourceDir, {
        recursive: true,
      })
    } catch (error) {
      this.#emitError(error)
      return
    }

    for (const entry of entries) {
      const entryPath = path.resolve(this.#compiler.sourceDir, entry)

      if (this.#isIgnored(entryPath)) {
        continue
      }

      try {
        const entryStat = await this.#deps.statFn(entryPath)

        if (entryStat.isDirectory()) {
          this.#liveDirs.add(entryPath)
        } else {
          this.#liveFiles.add(entryPath)
        }
      } catch {
        // vanished between readdir and stat — nothing to track
      }
    }
  }
}

function createChokidarWatcher(compiler: Compiler): SourceWatcher {
  const { options, sourceDir } = compiler

  // chokidar 4+ compares string `ignored` entries literally (glob support
  // was removed), so the ignore list goes through a matcher function.
  const watcher = chokidar.watch(sourceDir, {
    ignoreInitial: true,
    ignored: createIgnoreMatcher([...options.ignore, ENV_PATTERN]),
    ...options.watch.chokidar,
  })

  const ready = new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve())
  })

  return Object.assign(watcher as unknown as SourceWatcher, { ready })
}

export function watchSource(compiler: Compiler): SourceWatcher {
  const { logger, sourceDir } = compiler
  const handlers = createWatchHandlers(compiler)
  const backend = canWatchRecursively(compiler)
    ? new RecursiveWatcher(compiler)
    : createChokidarWatcher(compiler)

  backend.on('add', (filePath) => {
    handlers.record(filePath, 'add')
  })
  backend.on('change', (filePath) => {
    handlers.record(filePath, 'change')
  })
  backend.on('unlink', (filePath) => {
    handlers.record(filePath, 'unlink')
  })
  backend.on('error', (error) => {
    logger.error(String(error))
  })

  logger.info(`watching ${sourceDir}`)

  return backend
}
