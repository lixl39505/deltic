import type { Plugin } from '../types.js'
import { cleanPlugin } from './clean.js'
import { compileCachePlugin } from './compile-cache.js'
import { depGraphPlugin } from './dep-graph.js'
import { definePlugin } from './define-plugin.js'

export { cleanPlugin } from './clean.js'
export { compileCachePlugin, type CompileCachePluginOptions } from './compile-cache.js'
export { depGraphPlugin } from './dep-graph.js'
export { definePlugin }

/** Plugins installed by default when the user does not configure any. */
export function defaultPlugins(): Plugin[] {
  return [compileCachePlugin(), depGraphPlugin(), cleanPlugin()]
}
