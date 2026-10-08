import type { Plugin } from '../types.js'
import { cleanPlugin } from './clean.js'
import { compileCachePlugin } from './compile-cache.js'
import { depGraphPlugin } from './dep-graph.js'
import { definePlugin } from './define-plugin.js'

export { cleanPlugin } from './clean.js'
export { compileCachePlugin, type CompileCachePluginOptions } from './compile-cache.js'
export { depGraphPlugin } from './dep-graph.js'
export { definePlugin }

/**
 * The builtin plugin trio: compile cache, dependency graph, output cleaning.
 *
 * They are mandatory — `resolveOptions` always installs them, even when the
 * config sets `plugins` — because deltic cannot compile without them.
 * Providing a plugin under one of these names replaces that builtin.
 */
export function defaultPlugins(): Plugin[] {
  return [compileCachePlugin(), depGraphPlugin(), cleanPlugin()]
}
