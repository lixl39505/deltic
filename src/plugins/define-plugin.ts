import type { Plugin, PluginContext } from '../types.js'

export function definePlugin(
  name: string,
  setup: (api: PluginContext) => void | Promise<void>,
): Plugin {
  return { name, setup }
}
