import path from 'node:path'

import { BUILTIN_PIPES } from '../pipes/index.js'
import { defaultPlugins } from '../plugins/index.js'
import { CapabilityMissingError, ConfigError } from '../errors.js'
import { dedup } from '../utils/array.js'
import { createLogger } from '../utils/logger.js'
import { escapeGlobLiteral, joinGlob, toGlobPath } from '../utils/paths.js'
import { createNodeTimer } from '../utils/timing.js'
import { loadEnvFiles } from './env.js'
import type {
  NormalizedTaskConfig,
  PipeOptions,
  PipeRef,
  PipeFactory,
  Plugin,
  PluginFactory,
  ProfileOptions,
  ResolvedOptions,
  UserConfig,
} from '../types.js'

export interface ResolveContext {
  /** Named pipes registered globally via `Compiler.setPipe`. */
  globalPipes?: Record<string, PipeFactory>
  /** Plugins registered globally via `Compiler.use`. */
  globalPlugins?: Plugin[]
}

function toArray(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return typeof value === 'string' ? [value] : [...value]
}

function instantiate(
  plugin: Plugin | PluginFactory,
  pluginOptions?: PipeOptions,
): Plugin {
  return typeof plugin === 'function' ? plugin(pluginOptions) : plugin
}

// UserConfig → ResolvedOptions: apply defaults, resolve paths, normalize
// tasks and validate pipe/plugin wiring. No implicit tasks are registered.
export function resolveOptions(
  user: UserConfig,
  context: ResolveContext = {},
): ResolvedOptions {
  const baseDir = path.resolve(user.baseDir ?? process.cwd())
  const source = user.source ?? 'src'
  const output = user.output ?? 'dist'
  const cacheDirName = user.cacheDir ?? '.deltic'
  const sourceDir = path.resolve(baseDir, source)
  const outputDir = path.resolve(baseDir, output)
  const cacheDir = path.resolve(baseDir, cacheDirName)
  const mode = user.mode ?? 'development'
  const logger = user.logger ?? createLogger()
  const timer = user.timer ?? createNodeTimer()

  const ignore = dedup([
    '**/node_modules/**',
    ...toArray(user.ignore),
    joinGlob(outputDir, '**'),
    joinGlob(cacheDir, '**'),
  ])

  const alias: Record<string, string> = {}

  for (const [key, value] of Object.entries(user.alias ?? {})) {
    alias[key] = /^https?:\/\//.test(value) ? value : path.resolve(baseDir, value)
  }

  // env: .env files (default on) ⊕ explicit env values ⊕ mode marker.
  const rawLoadEnv = user.loadEnv
  const loadEnv = rawLoadEnv !== false
  const env: Record<string, string> = {}

  if (loadEnv) {
    const option: { mode?: string; dir?: string } =
      rawLoadEnv === true || rawLoadEnv === undefined ? {} : rawLoadEnv

    Object.assign(env, loadEnvFiles(option.dir ?? baseDir, option.mode ?? mode))
  }

  for (const [key, value] of Object.entries(user.env ?? {})) {
    if (value !== undefined) {
      env[key] = typeof value === 'string' ? value : String(value)
    }
  }

  env.mode = mode

  const profile: ProfileOptions = {
    enabled: user.profile === true,
    topPipes: 10,
    topFiles: 20,
    ...(user.profile === false || user.profile === undefined
      ? {}
      : typeof user.profile === 'object'
        ? user.profile
        : {}),
  }

  if (typeof user.profile === 'object') {
    profile.enabled = user.profile.enabled ?? true
  }

  // pipes: builtin ⊕ global ⊕ user
  const pipes: ResolvedOptions['pipes'] = { ...BUILTIN_PIPES }

  for (const [name, factory] of Object.entries(context.globalPipes ?? {})) {
    pipes[name] = { name, factory }
  }

  for (const [name, factory] of Object.entries(user.pipes ?? {})) {
    pipes[name] = { name, factory }
  }

  // plugins: builtins ⊕ user ⊕ global. The builtin trio (compile cache,
  // dependency graph, output cleaning) is what makes deltic compile at all,
  // so it is always installed — configuring `plugins` extends the builtins
  // instead of replacing them. Registering a plugin under a builtin's name
  // replaces that builtin.
  const configuredPlugins: Plugin[] = [
    ...(user.plugins ?? []).map((plugin) => instantiate(plugin)),
    ...(context.globalPlugins ?? []),
  ]
  const replaced = new Set(configuredPlugins.map((plugin) => plugin.name))
  const plugins: Plugin[] = [
    ...defaultPlugins().filter((plugin) => !replaced.has(plugin.name)),
    ...configuredPlugins,
  ]

  const installed = new Set(plugins.map((plugin) => plugin.name))

  // tasks (two-phase so test functions can read the resolved options)
  const options = {
    config: user.config ?? '',
    baseDir,
    source,
    sourceDir,
    output,
    outputDir,
    cacheDir,
    ignore,
    alias,
    taskTypeMap: { ...user.taskTypeMap },
    mode,
    env,
    loadEnv,
    tasks: {} as ResolvedOptions['tasks'],
    pipes,
    plugins,
    profile,
    progress: user.progress ?? true,
    watch: {
      debounceMs: user.watch?.debounceMs ?? 200,
      chokidar: user.watch?.chokidar ?? {},
    },
    logger,
    timer,
  } satisfies ResolvedOptions

  options.tasks = normalizeTasks(user.tasks, options)

  return options
}

export function normalizeTask(
  name: string,
  config: UserConfig['tasks'][string],
  options: ResolvedOptions,
  installedPipes: Record<string, { name: string; factory: PipeFactory; requires?: readonly string[] }> = options.pipes,
  installedPlugins: ReadonlySet<string> = new Set(options.plugins.map((plugin) => plugin.name)),
): NormalizedTaskConfig {
  if (config === undefined || config === null) {
    throw new ConfigError(`task "${name}" must not be empty`)
  }

  const { test, use, compileAncestor = false, cache = true, output = true } = config

  if (test === undefined || use === undefined) {
    throw new ConfigError(`task "${name}" requires both "test" and "use"`)
  }

  // test → { globs, options }
  const rawTest = typeof test === 'function' ? test(options) : test

  const sourceTest: {
    globs: string | readonly string[]
    options?: Record<string, unknown>
  } =
    typeof rawTest === 'object' && rawTest !== null && 'globs' in rawTest
      ? (rawTest as { globs: string | readonly string[]; options?: Record<string, unknown> })
      : { globs: rawTest as string | readonly string[] }

  const globs = (
    typeof sourceTest.globs === 'string' ? [sourceTest.globs] : [...sourceTest.globs]
  ).map((glob) =>
    path.isAbsolute(glob)
      ? escapeGlobLiteral(glob)
      : joinGlob(options.sourceDir, glob),
  )

  const testOptions: Record<string, unknown> = { ...sourceTest.options }
  const ignore = dedup([
    ...toArray(testOptions.ignore as string | readonly string[] | undefined).map((entry) =>
      toGlobPath(entry),
    ),
    ...options.ignore,
  ])
  testOptions.ignore = ignore

  // use → normalized refs against the pipe registry
  const useRefs: PipeRef[] = Array.isArray(use)
    ? (use as unknown as PipeRef[])
    : [use as PipeRef]

  const normalized = useRefs.map((ref, index) => {
    const { refName, factory, refOptions } = destructure(ref)
    const def = factory === undefined ? installedPipes[refName] : undefined

    if (factory === undefined && def === undefined) {
      throw new ConfigError(
        `task "${name}" references unknown pipe "${refName}" at use[${index}]`,
      )
    }

    const pipeName = def?.name ?? refName
    const resolvedFactory = factory ?? def!.factory
    const pipeOptions =
      typeof refOptions === 'function' ? refOptions(options) : refOptions

    const requires = factory === undefined ? (def!.requires ?? []) : []

    for (const dependency of requires) {
      if (!installedPlugins.has(dependency)) {
        throw new CapabilityMissingError(pipeName, [dependency])
      }
    }

    return { name: pipeName, factory: resolvedFactory, options: pipeOptions }
  })

  if (cache && !installedPlugins.has('compile-cache')) {
    throw new CapabilityMissingError(`task "${name}" cache gate`, ['compile-cache'])
  }

  return {
    name,
    test: { globs, options: testOptions },
    use: normalized,
    compileAncestor,
    cache,
    output,
  }
}

function destructure(ref: PipeRef): {
  refName: string
  factory?: PipeFactory
  refOptions?: PipeOptions | ((options: ResolvedOptions) => PipeOptions)
} {
  if (typeof ref === 'string') {
    return { refName: ref }
  }

  if (typeof ref === 'function') {
    return { refName: ref.name || 'anonymous', factory: ref }
  }

  const [target, refOptions] = ref

  if (typeof target === 'string') {
    return { refName: target, refOptions }
  }

  return { refName: target.name || 'anonymous', factory: target, refOptions }
}

export function normalizeTasks(
  tasks: UserConfig['tasks'],
  options: ResolvedOptions,
): Record<string, NormalizedTaskConfig> {
  const result: Record<string, NormalizedTaskConfig> = {}

  for (const [name, config] of Object.entries(tasks)) {
    result[name] = normalizeTask(name, config, options)
  }

  return result
}
