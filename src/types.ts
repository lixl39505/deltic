import type { ChokidarOptions } from 'chokidar'
import type { Transform } from 'streamx'
import type Vinyl from 'vinyl'

import type {
  Matcher,
  CleanCapabilities,
  CompileCacheCapabilities,
  DepGraphCapabilities,
  DepNode,
} from './capabilities.js'
import type { Compiler } from './compiler.js'
import type { Logger } from './utils/logger.js'
import type { Timer } from './utils/timing.js'

// ---------------------------------------------------------------------------
// Capability surface (see capabilities.ts for the member contracts)
// ---------------------------------------------------------------------------

/**
 * Capability methods injected into CompileContext / FileContext / SessionContext
 * by installed plugins at runtime.
 *
 * Members are optional: a capability only exists when its plugin is installed.
 * Builtin pipes declare their requirements and the compiler validates them at
 * assembly time, so a missing plugin surfaces as a readable ConfigError instead
 * of a runtime TypeError.
 */
export interface Capabilities
  extends Partial<CleanCapabilities>,
    Partial<CompileCacheCapabilities>,
    Partial<DepGraphCapabilities> {}

export type { Matcher, Vinyl }
export type {
  CheckFileChangedResult,
  CheckFileChangedSettings,
  CleanCapabilities,
  CompileCacheCapabilities,
  DependOptions,
  DepGraphCapabilities,
  DepNode,
  FileRef,
} from './capabilities.js'

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

export type PipeOptions = Record<string, unknown>

/**
 * A pipe factory receives its task-level options; omitted options stay undefined.
 * Combo pipes may return multiple stages — the task chain flattens them and
 * profiles each stage individually.
 */
export type PipeFactory = (options?: PipeOptions) => Transform | Transform[]

export interface PipeDef {
  name: string
  factory: PipeFactory
  /** Plugin names that must be installed for this pipe to work. */
  requires?: readonly string[]
}

// ---------------------------------------------------------------------------
// Tasks & config
// ---------------------------------------------------------------------------

export interface SourceTest {
  globs: string | readonly string[]
  options?: Record<string, unknown>
}

export type SourceTestInput =
  | string
  | readonly string[]
  | SourceTest
  | ((options: ResolvedOptions) => string | readonly string[] | SourceTest)

export type PipeOptionsInput =
  | PipeOptions
  | ((options: ResolvedOptions) => PipeOptions)

export type PipeRef =
  | string
  | PipeFactory
  | [string | PipeFactory, PipeOptionsInput]

export interface TaskConfig {
  test: SourceTestInput
  use: PipeRef | readonly PipeRef[]
  /** Re-compile modules upstream of this file when it changes (default false). */
  compileAncestor?: boolean
  /** Route files through the compile-cache gate (default true). */
  cache?: boolean
  /** Write results to the output directory (default true). */
  output?: boolean
}

export interface NormalizedPipeRef {
  name: string
  factory: PipeFactory
  options?: PipeOptions
}

export interface NormalizedTaskConfig {
  name: string
  test: { globs: string[]; options: Record<string, unknown> }
  use: NormalizedPipeRef[]
  compileAncestor: boolean
  cache: boolean
  output: boolean
}

export interface ProfilePipeTiming {
  task: string
  pipe: string
  files: number
  totalMs: number
  avgMs: number
  maxMs: number
  maxFile?: string
}

export interface ProfileFileTiming {
  path: string
  totalMs: number
  cached: boolean
  pipes: Record<string, number>
}

export interface ProfileTaskTiming {
  totalMs: number
  files: number
  cached: number
}

export interface ProfileReport {
  totalMs: number
  pipes: ProfilePipeTiming[]
  files: ProfileFileTiming[]
  tasks: Record<string, ProfileTaskTiming>
}

export interface ProfileOptions {
  enabled: boolean
  topPipes: number
  topFiles: number
}

// ---------------------------------------------------------------------------
// User config & resolved options
// ---------------------------------------------------------------------------

export type EnvValue = string | boolean | number | undefined

export interface UserConfig {
  /** Source directory relative to baseDir (default 'src'). */
  source?: string
  /** Output directory relative to baseDir (default 'dist'). */
  output?: string
  /** State directory relative to baseDir (default '.deltic'). */
  cacheDir?: string
  /** Project root; defaults to the config file directory (or cwd). */
  baseDir?: string
  /** Config file location (informational; used by the CLI). */
  config?: string
  /** Extra ignore globs; output/cache/node_modules are always ignored. */
  ignore?: string | readonly string[]
  /** Path aliases resolved against baseDir. */
  alias?: Record<string, string>
  /**
   * Maps a file extension (without dot) onto a task name for incremental
   * compiles, e.g. `{ jpg: 'img' }` routes `.jpg` changes to the `img` task.
   * Unmapped extensions resolve to the task named after the extension itself.
   */
  taskTypeMap?: Record<string, string>
  /** Environment values replaced into sources; overrides loaded .env files. */
  env?: Record<string, EnvValue>
  /** Read .env files (default true); never mutates process.env. */
  loadEnv?: boolean | { mode?: string; dir?: string }
  mode?: string
  /** Task set — required; nothing is registered implicitly. */
  tasks: Record<string, TaskConfig>
  /** Instance-level named pipes, merged over the builtin registry. */
  pipes?: Record<string, PipeFactory>
  /**
   * Instance-level plugins, appended to the builtin set
   * (`compile-cache` + `dep-graph` + `clean`), which is always installed.
   * A plugin reusing a builtin's name replaces that builtin.
   */
  plugins?: readonly (Plugin | PluginFactory)[]
  /** Performance profiling of pipes and files. */
  profile?: boolean | Partial<ProfileOptions>
  /** Render a [done/total] progress line while compiling (default true). */
  progress?: boolean
  watch?: { debounceMs?: number; chokidar?: ChokidarOptions }
  logger?: Logger
  timer?: Timer
}

export interface ResolvedOptions {
  config: string
  baseDir: string
  source: string
  sourceDir: string
  output: string
  outputDir: string
  cacheDir: string
  ignore: string[]
  alias: Record<string, string>
  taskTypeMap: Record<string, string>
  mode: string
  env: Record<string, string>
  loadEnv: boolean
  tasks: Record<string, NormalizedTaskConfig>
  pipes: Record<string, PipeDef>
  plugins: Plugin[]
  profile: ProfileOptions
  progress: boolean
  watch: { debounceMs: number; chokidar: ChokidarOptions }
  logger: Logger
  timer: Timer
}

// ---------------------------------------------------------------------------
// Plugins & hooks
// ---------------------------------------------------------------------------

export interface HookPayloads {
  init: { compiler: Compiler }
  clean: { expired: string[] }
  beforeCompile: { session: SessionContext }
  afterCompile: { session: SessionContext }
  taskError: { error: unknown; session?: SessionContext }
}

export type HookName = keyof HookPayloads

export type HookHandler<K extends HookName = HookName> = (
  payload: HookPayloads[K],
) => void | Promise<void>

export type Unsubscribe = () => void

export interface HookRegistry {
  on<K extends HookName>(name: K, handler: HookHandler<K>): Unsubscribe
  fire<K extends HookName>(name: K, payload: HookPayloads[K]): Promise<void>
  listenerCount<K extends HookName>(name: K): number
}

export interface ContextExtension {
  /**
   * Methods installed on the compiler instance and its contexts.
   * `this` inside a capability is bound to the compiler.
   */
  capabilities?: Record<string, unknown>
}

/** Key-value store for small metadata (env snapshots, tool versions, config checksums). */
export interface MetaStore {
  get<T>(key: string, defaults: T): T
  set(key: string, value: unknown): void
}

/** path → mtimeMs rows for the compile cache. */
export interface CompiledStore {
  all(): Record<string, number>
  upsert(entries: Iterable<[string, number]>): void
  remove(paths: readonly string[]): void
}

/**
 * Content checksums grouped by namespace scope; the root scope ('@') holds
 * un-namespaced sums such as the config checksum.
 */
export interface ChecksumStore {
  all(): Record<string, Record<string, string>>
  upsert(scope: string, entries: Iterable<[string, string]>): void
  /** Removes rows for the given paths across every scope. */
  removePaths(paths: readonly string[]): void
}

/** Tracked source files (fast-glob format: absolute paths with forward slashes). */
export interface FileListStore {
  all(): string[]
  add(paths: readonly string[]): void
  remove(paths: readonly string[]): void
}

/** source id → emitted output paths, recorded per compile for exact cleanup. */
export interface OutputsStore {
  all(): Record<string, string[]>
  upsert(entries: Iterable<[string, readonly string[]]>): void
  remove(ids: readonly string[]): void
}

/** Dependency-graph nodes; edges are stored per node. */
export interface GraphStore {
  all(): Record<string, DepNode>
  upsert(nodes: Iterable<DepNode>): void
  remove(ids: readonly string[]): void
}

/**
 * SQLite-backed persistence. Mutations land in in-memory queues and are
 * committed in one transaction by `flush()` (called at the end of every run
 * and by `compiler.stop()`).
 */
export interface StateStore {
  readonly meta: MetaStore
  readonly compiled: CompiledStore
  readonly checksums: ChecksumStore
  readonly files: FileListStore
  readonly graph: GraphStore
  readonly outputs: OutputsStore
  flush(): void
  close(): void
}

export interface PluginContext {
  readonly compiler: Compiler
  readonly hooks: HookRegistry
  readonly logger: Logger
  readonly store: StateStore
  registerPipe(name: string, factory: PipeFactory): void
  extendContext(extension: ContextExtension): void
}

export interface Plugin {
  /** Unique capability id, e.g. 'clean' | 'dep-graph' | 'compile-cache'. */
  name: string
  setup(api: PluginContext): void | Promise<void>
}

export type PluginFactory = (options?: PipeOptions) => Plugin

// ---------------------------------------------------------------------------
// Compile contexts
// ---------------------------------------------------------------------------

export interface CompileContext extends Capabilities {
  readonly options: ResolvedOptions
  readonly baseDir: string
  readonly sourceDir: string
  readonly outputDir: string
  readonly cacheDir: string
  readonly logger: Logger
  /** Resolve a request the way module resolution would (alias/relative/bare). */
  resolve(request: string, relativePath?: string): string
  query<T>(key: string, defaults: T): T
  save(key: string, value: unknown): void
}

export interface FileContext extends CompileContext {
  /** Original path a derived file came from (equals file.path otherwise). */
  readonly originalPath: string
  /** Extra dependency ids collected outside of matcher scanning (e.g. .env keys). */
  readonly customDeps: string[]
  /** Guards against clearing collected dependencies twice. */
  depended: boolean
  readonly session: SessionContext
}

/** One file emitted by a task pipeline during a session. */
export interface SessionOutput {
  /** Source path the file came from (`context.originalPath`). */
  source: string
  /** Absolute path written to the output directory. */
  path: string
}

export interface SessionContext extends CompileContext {
  startTime: number
  endTime: number
  /** Files that actually went through (non-cached) compilation. */
  readonly files: string[]
  /** Files emitted to the output directory, per source (for exact cleanup). */
  readonly outputs: SessionOutput[]
  /** Number of files seen by the pipeline. */
  total: number
  /** Files considered by the cache gate. */
  totalCache: number
  /** Files skipped by the cache gate. */
  totalHit: number
  /** null when profiling is disabled. */
  profile: ProfileReport | null
}
