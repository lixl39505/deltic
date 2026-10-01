export { Compiler } from './compiler.js'
export { defineConfig, loadConfig } from './config/index.js'
export { resolveOptions } from './config/resolve.js'
export { preset } from './preset/index.js'

export {
  compileCachePlugin,
  cleanPlugin,
  defaultPlugins,
  definePlugin,
  depGraphPlugin,
} from './plugins/index.js'

export { BUILTIN_PIPES } from './pipes/index.js'
export { SqliteState } from './store/sqlite-state.js'
export { Profiler, renderProfile } from './core/profile.js'
export { Progress, createLineRenderer } from './core/progress.js'

// Path helpers for plugin authors — always use these instead of hand-rolling
// path.relative / String.replace / raw glob concatenation (see README
// "Path rules").
export {
  escapeGlobLiteral,
  joinGlob,
  stripBase,
  toGlobPath,
} from './utils/paths.js'
export { relativeId } from './plugins/dep-graph.js'

export {
  CapabilityMissingError,
  CompileError,
  ConfigError,
  UnknownHookError,
} from './errors.js'

export * from './types.js'
export type {
  CheckFileChangedResult,
  CheckFileChangedSettings,
  CleanCapabilities,
  CompileCacheCapabilities,
  DependOptions,
  DepGraphCapabilities,
  DepNode,
  FileRef,
  Matcher,
} from './capabilities.js'
