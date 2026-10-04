import { mkdirSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

import { resolveOptions } from './config/resolve.js'
import { ConfigError } from './errors.js'
import { createFileContext, createSession } from './core/context.js'
import { HookRegistryImpl } from './core/hooks.js'
import { Profiler, renderProfile } from './core/profile.js'
import { Progress, createLineRenderer, type ProgressRenderer } from './core/progress.js'
import { TaskScheduler } from './core/scheduler.js'
import { createTransform } from './pipes/stream.js'
import { watchSource } from './core/watcher.js'
import {
  gulpDest,
  gulpSeries,
  gulpSrc,
  installGulpErrorHandler,
  type GulpTaskFn,
  type PipeSource,
} from './core/vfs.js'
import { SqliteState } from './store/sqlite-state.js'
import { relativeId } from './plugins/dep-graph.js'
import { dedup, groupBy } from './utils/array.js'
import { escapeGlobLiteral, toGlobPath } from './utils/paths.js'
import { scanFiles } from './utils/glob.js'
import type {
  Capabilities,
  FileContext,
  HookHandler,
  HookName,
  HookPayloads,
  NormalizedTaskConfig,
  PipeDef,
  PipeFactory,
  PipeOptions,
  Plugin,
  PluginContext,
  PluginFactory,
  ResolvedOptions,
  SessionContext,
  Unsubscribe,
  UserConfig,
  Vinyl,
} from './types.js'
import VinylPkg from 'vinyl'
import type {
  Readable as StreamxReadable,
  Transform as StreamxTransform,
  Writable as StreamxWritable,
} from 'streamx'
import { Readable, Writable, type Transform } from 'streamx'
import type { SourceWatcher } from './core/watcher.js'

const require = createRequire(import.meta.url)
const pkgInfo = require('../package.json') as { version: string }

const silentRenderer: ProgressRenderer = {
  render() {},
  stop() {},
}

export function instrument(
  stage: StreamxTransform,
  measure: (chunk: Vinyl, elapsedMs: number) => void,
): Transform {
  const original = stage._transform.bind(stage)

  stage._transform = (chunk, cb) => {
    const start = performance.now()

    original(chunk, (err, data) => {
      measure(chunk as Vinyl, performance.now() - start)
      cb(err, data)
    })
  }

  return stage
}

// The incremental compile orchestrator: config → plugins → store →
// src/context/cache/pipes/dest/progress pipeline → dependency-graph upkeep.
export class Compiler {
  readonly options: ResolvedOptions
  readonly baseDir: string
  readonly sourceDir: string
  readonly outputDir: string
  readonly cacheDir: string
  readonly version: string
  readonly ready: Promise<this>
  readonly hooks = new HookRegistryImpl()

  readonly #scheduler = new TaskScheduler()
  readonly #store: SqliteState
  #closed = false
  readonly #pipes: Map<string, PipeDef>
  readonly #profiler: Profiler
  readonly #progress: Progress
  #watcher: SourceWatcher | null = null
  #running = false

  static #globalPipes = new Map<string, PipeFactory>()
  static #globalPlugins: Plugin[] = []

  constructor(userConfig: UserConfig) {
    this.options = resolveOptions(userConfig, {
      globalPipes: Object.fromEntries(Compiler.#globalPipes),
      globalPlugins: [...Compiler.#globalPlugins],
    })

    this.baseDir = this.options.baseDir
    this.sourceDir = this.options.sourceDir
    this.outputDir = this.options.outputDir
    this.cacheDir = this.options.cacheDir
    this.version = pkgInfo.version

    mkdirSync(this.cacheDir, { recursive: true })

    this.#store = new SqliteState({ file: path.join(this.cacheDir, 'state.db') })
    this.#pipes = new Map(Object.entries(this.options.pipes))
    this.#profiler = new Profiler(this.options.profile, () =>
      this.options.timer.now(),
    )
    this.#progress = new Progress(
      this.options.progress
        ? createLineRenderer((text) => process.stdout.write(text))
        : silentRenderer,
    )

    installGulpErrorHandler((error) => {
      this.options.logger.error(
        error instanceof Error ? error.message : String(error),
      )
    })

    this.ready = this.#init().then(() => this)
  }

  // ---------------------------------------------------------------- lifecycle

  async #init(): Promise<void> {
    for (const plugin of this.options.plugins) {
      await plugin.setup(this.#createPluginContext())
    }

    await this.hooks.fire('init', { compiler: this })
  }

  #createPluginContext(): PluginContext {
    return {
      compiler: this,
      hooks: this.hooks,
      logger: this.options.logger,
      store: this.#store,
      registerPipe: (name: string, factory: PipeFactory): void => {
        this.#pipes.set(name, { name, factory })
      },
      extendContext: ({ capabilities }: { capabilities?: Record<string, (...args: never[]) => unknown> }): void => {
        const target = this as unknown as Record<string, unknown>

        for (const [name, fn] of Object.entries(capabilities ?? {})) {
          target[name] = (fn as (...args: unknown[]) => unknown).bind(this)
        }
      },
    }
  }

  /** Full compile: clean expired artifacts → compile → upstream compensation. */
  async run(): Promise<SessionContext> {
    if (this.#running) {
      throw new Error('compiler is already running')
    }

    this.#running = true

    try {
      await this.ready

      const session = createSession(this)

      try {
        const expired = await this.capability('cleanExpired')?.() ?? []
        await this.hooks.fire('clean', { expired })
        await this.#runTasks(this.options.tasks, session)
        await this.#compileUpStream(session)
      } catch (error) {
        await this.hooks
          .fire('taskError', { error, session })
          .catch(() => {})
        throw error
      }

      return session
    } finally {
      this.#running = false
    }
  }

  /** Runs a full compile, then keeps watching the source tree. */
  async watch(): Promise<SessionContext> {
    const session = await this.run()

    this.#watcher = watchSource(this)
    // wait for the initial scan so early writes are not swallowed
    await new Promise<void>((resolve) => {
      this.#watcher!.once('ready', () => resolve())
    })

    return session
  }

  /** Stops watching, aborts queued work, flushes plugin and store state. */
  async stop(): Promise<void> {
    if (this.#closed) {
      return
    }

    const watcher = this.#watcher

    this.#watcher = null
    await watcher?.close()
    this.#scheduler.abort(new Error('compiler stopped'))

    this.#store.close()
    this.#closed = true
  }

  // ------------------------------------------------------------------ run flow

  async #runTasks(
    tasks: Record<string, NormalizedTaskConfig>,
    session: SessionContext,
  ): Promise<SessionContext> {
    const entries = Object.values(tasks)

    this.#progress.reset()

    // Single directory walk per run: the scan feeds the progress counter
    // AND (after the cache pre-filter) the runners as literal file lists —
    // gulpSrc is not used at all, so the tree is never traversed twice and
    // per-pattern matcher costs never apply.
    const scanned = new Map<string, string[]>(
      entries.map((task) => [
        task.name,
        scanFiles(task.test.globs, {
          ignore: task.test.options.ignore as string[] | undefined,
          dot: task.test.options.dot === true,
        }),
      ]),
    )

    const total = [...scanned.values()].reduce(
      (sum, files) => sum + files.length,
      0,
    )

    session.total = total
    this.#progress.append(total)
    this.#profiler.startSession()

    await this.hooks.fire('beforeCompile', { session })

    // Cache pre-filter: resolve hits BEFORE anything enters the pipeline so
    // warm runs never read/build vinyls for files that would be dropped.
    // A plugin may claim the compile-cache name without providing the
    // capability — skip filtering rather than crash.
    const checkFileCached = this.capability('checkFileCached')

    for (const task of entries) {
      if (!task.cache) {
        continue
      }

      if (checkFileCached === undefined) {
        continue
      }

      // every entry has a scanned list; misses replace it in place
      const files = scanned.get(task.name)!
      const misses: string[] = []

      for (const filePath of files) {
        let mtimeMs: number

        try {
          mtimeMs = statSync(filePath).mtimeMs
        } catch {
          // vanished between scan and filter: let the pipeline surface it
          misses.push(filePath)
          continue
        }

        session.totalCache += 1

        const hit = checkFileCached(
          relativeId(filePath, this.sourceDir),
          mtimeMs,
          filePath,
          task.name,
        )

        if (hit) {
          session.totalHit += 1
        } else {
          misses.push(filePath)
        }
      }

      scanned.set(task.name, misses)
    }

    if (entries.length > 0) {
      const runners = entries
        .filter((task) => scanned.get(task.name)!.length > 0)
        .map((task) => this.#createTaskRunner(task, session, scanned.get(task.name)!))
      const finish: GulpTaskFn = (done) => {
        try {
          this.capability('reverseDep')?.()
          this.save('env', this.options.env)
          this.#store.flush()
          done()
        } catch (error) {
          done(error as Error)
        }
      }

      const run = gulpSeries(
        ...runners.map((runner): GulpTaskFn => (done) => {
          runner().then(() => done(), (error: Error) => done(error))
        }),
        finish,
      )

      await new Promise<void>((resolve, reject) => {
        run((err) => (err === undefined || err === null ? resolve() : reject(err)))
      })
    }

    this.#progress.stop()

    session.endTime = this.options.timer.now()
    session.profile = this.#profiler.report()

    const elapsed = session.endTime - session.startTime

    this.options.logger.info(
      `Compiling Time: ${elapsed < 10 ? '<10ms' : `${(elapsed / 1000).toFixed(2)}s`}`,
    )
    this.options.logger.info(
      `${session.totalHit}/${session.total} file skipped by cache`,
    )

    if (session.profile !== null) {
      renderProfile(session.profile, (line) => this.options.logger.info(line))
    }

    await this.hooks.fire('afterCompile', { session })

    return session
  }

  /**
   * Pull-driven source stream: streamx calls `read` when it wants data, so
   * stat/read happen exactly once per miss with no push-timing deadlock.
   */
  #createFileSource(files: string[]): StreamxReadable {
    let cursor = 0
    let source!: Readable

    source = new Readable({
      highWaterMark: 16,
      byteLength: () => 1,
      read: (cb) => {
        if (cursor >= files.length) {
          source.push(null)
          cb(null)
          return
        }

        const filePath = files[cursor++]!

        void Promise.all([stat(filePath), readFile(filePath)])
          .then(([fileStat, contents]) => {
            source.push(
              new VinylPkg({
                base: this.sourceDir,
                path: filePath,
                stat: fileStat,
                contents,
              }),
            )
            cb(null)
          })
          .catch((error: Error) => {
            cb(error)
          })
      },
    })

    return source
  }

  #createTaskRunner(
    config: NormalizedTaskConfig,
    session: SessionContext,
    files: string[],
  ): () => Promise<void> {
    const profiler = this.#profiler
    const progress = this.#progress

    const buildStages = (): Array<StreamxTransform | StreamxWritable> => {
      const stages: Array<StreamxTransform | StreamxWritable> = []

      const contextStage = createTransform('context', (file, next) => {
        file.context = createFileContext(this, file, session)
        session.files.push(file.path)
        profiler.startFile(file)
        next(null, file)
      })

      stages.push(contextStage)

      // cache gating happens in the pre-filter (before the pipeline); files
      // reaching this point are already misses

      for (const { name, factory, options: pipeOptions } of config.use) {
        const result = factory(pipeOptions)
        const pipeStages = Array.isArray(result) ? result : [result]

        for (let index = 0; index < pipeStages.length; index += 1) {
          const stage = pipeStages[index]!

          if (typeof (stage as unknown as PipeSource).on !== 'function') {
            throw new ConfigError(
              `pipe "${name}" must return a streamx Transform, got ${typeof stage}`,
            )
          }

          const label =
            pipeStages.length > 1 ? `${name}#${index + 1}` : name

          stages.push(
            instrument(stage, (chunk, elapsedMs) => {
              profiler.recordPipe(config.name, label, chunk, elapsedMs)
            }),
          )
        }
      }

      if (config.output) {
        stages.push(gulpDest(this.outputDir))
      }

      // The progress stage is a terminal Writable sink: a readable Transform
      // tail with no consumer stops draining past highWaterMark and deadlocks
      // the pipeline once more than ~16 files flow through.
      stages.push(
        new Writable({
          write: (chunk: unknown, callback: (err: Error | null, data?: unknown) => void) => {
            const file = chunk as Vinyl

            if (typeof (file as { path?: unknown })?.path === 'string') {
              profiler.endFile(config.name, file, false)

              // Record what dest actually wrote (source attribution via
              // originalPath) so the clean plugin can remove artifacts
              // precisely instead of guessing globs.
              if (config.output) {
                const context = (
                  file as { context?: { originalPath?: string } }
                ).context

                session.outputs.push({
                  source: context?.originalPath ?? file.path,
                  path: path.join(
                    this.outputDir,
                    path.relative(file.base, file.path),
                  ),
                })
              }
            }

            progress.increment()
            callback(null)
          },
        }),
      )

      return stages
    }

    return async (): Promise<void> => {
      profiler.startTask(config.name)

      try {
        await new Promise<void>((resolve, reject) => {
          const fail = (error: Error): void => {
            reject(error)
          }

          let current: StreamxReadable | StreamxTransform | StreamxWritable =
            this.#createFileSource(files)

          current.on('error', fail)

          for (const stage of buildStages()) {
            stage.on('error', fail)
            current = (current as StreamxReadable | StreamxTransform).pipe(
              stage,
            ) as StreamxTransform | StreamxWritable
          }

          const tail = current as StreamxTransform | StreamxWritable

          tail.on('finish', () => resolve())
          tail.on('error', fail)
        })
      } finally {
        profiler.endTask(config.name)
      }
    }
  }

  // ------------------------------------------------------------ compile paths

  async #compileUpStream(session: SessionContext): Promise<void> {
    // Cached files can leave upstream modules stale — recompile them.
    if (session.totalHit <= 0) {
      return
    }

    const traceReverseDep = this.capability('traceReverseDep')

    if (traceReverseDep === undefined) {
      return
    }

    const downs = new Set(session.files)
    const ups: string[] = []

    for (const file of session.files) {
      ups.push(
        ...traceReverseDep(file).map((id) => path.join(this.sourceDir, id)),
      )
    }

    await this.incrementCompile(ups.filter((up) => !downs.has(up)), false)
  }

  #traceUpstreamModules(filePaths: readonly string[]): string[] {
    const traceReverseDep = this.capability('traceReverseDep')

    if (traceReverseDep === undefined) {
      return []
    }

    const ups: string[] = []

    for (const filePath of filePaths) {
      const task = this.options.tasks[this.getTaskType(filePath)]

      if (task?.compileAncestor === true) {
        ups.push(
          ...traceReverseDep(filePath).map((id) =>
            path.join(this.sourceDir, id),
          ),
        )
      }
    }

    return dedup(ups)
  }

  /**
   * Compiles specific files (plus their upstream modules when `trace` is set
   * and the task opted into `compileAncestor`). Incremental batches always
   * bypass the compile cache.
   */
  async incrementCompile(
    filePaths: string | readonly string[],
    trace = true,
  ): Promise<void> {
    const input = typeof filePaths === 'string' ? [filePaths] : [...filePaths]

    if (input.length === 0) {
      return
    }

    const targets = dedup([
      ...input,
      ...(trace ? this.#traceUpstreamModules(input) : []),
    ])
    const grouped = groupBy(targets, (filePath) => this.getTaskType(filePath))
    const batch: Record<string, NormalizedTaskConfig> = {}

    for (const [type, paths] of Object.entries(grouped)) {
      const task = this.options.tasks[type]

      if (task === undefined) {
        this.options.logger.warn(`Compiling .${type} files is not supported`)
        continue
      }

      batch[type] = {
        ...task,
        test: {
          globs: paths.map((filePath) => escapeGlobLiteral(filePath)),
          options: task.test.options,
        },
        cache: false,
      }
    }

    if (Object.keys(batch).length === 0) {
      return
    }

    await this.#scheduler.push(() =>
      this.#runTasks(batch, createSession(this)),
    )
  }

  /** Serializes background work (incremental compiles, cleanups). */
  schedule<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.#scheduler.push(fn)
  }

  // -------------------------------------------------------------- public API

  getTaskType(filePath: string): string {
    const ext = path.extname(filePath).replace('.', '')

    return this.options.taskTypeMap[ext] ?? ext
  }

  get logger(): ResolvedOptions['logger'] {
    return this.options.logger
  }

  capability<K extends keyof Capabilities>(name: K): Capabilities[K] {
    return (this as unknown as Capabilities)[name]
  }

  resolve(request: string, relativePath?: string): string {
    const base = relativePath === undefined ? this.sourceDir : path.dirname(relativePath)

    if (path.isAbsolute(request)) {
      return path.join(this.sourceDir, request)
    }

    if (request.startsWith('./') || request.startsWith('../')) {
      return path.resolve(base, request)
    }

    return path.resolve(this.sourceDir, request)
  }

  query<T>(key: string, defaults: T): T {
    return this.#store.meta.get(key, defaults)
  }

  save(key: string, value: unknown): void {
    if (key) {
      this.#store.meta.set(key, value)
    }
  }

  on<K extends HookName>(name: K, handler: HookHandler<K>): Unsubscribe {
    return this.hooks.on(name, handler)
  }

  fire<K extends HookName>(name: K, payload: HookPayloads[K]): Promise<void> {
    return this.hooks.fire(name, payload)
  }

  setPipe(name: string, factory: PipeFactory): void {
    this.#pipes.set(name, { name, factory })
  }

  getPipe(name: string): PipeFactory | undefined {
    return this.#pipes.get(name)?.factory
  }

  removePipe(name: string): void {
    this.#pipes.delete(name)
  }

  // ----------------------------------------------------------- static registry

  /** Registers a plugin for every compiler created afterwards. */
  static use(plugin: Plugin | PluginFactory, options?: PipeOptions): void {
    Compiler.#globalPlugins.push(
      typeof plugin === 'function' ? plugin(options) : plugin,
    )
  }

  static setPipe(name: string, factory: PipeFactory): void {
    Compiler.#globalPipes.set(name, factory)
  }

  static getPipe(name: string): PipeFactory | undefined {
    return Compiler.#globalPipes.get(name)
  }

  static removePipe(name: string): void {
    Compiler.#globalPipes.delete(name)
  }
}
