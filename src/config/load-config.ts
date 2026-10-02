import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

import { ConfigError } from '../errors.js'
import type { UserConfig } from '../types.js'

export interface LoadedConfig<T = unknown> {
  config: T
  file: string
}

export interface ConfigLoaderOptions {
  /** Candidate config file names, tried in order inside the base directory. */
  names: readonly string[]
  /**
   * Extra jiti aliases — map a package name to its entry file so user
   * configs can `import ... from '<pkg>'` without a local installation.
   */
  alias?: Record<string, string>
}

export type ConfigLoader<T = unknown> = (
  baseDir?: string,
  explicitFile?: string,
) => LoadedConfig<T> | undefined

const require = createRequire(import.meta.url)

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    typeof (value as { default: unknown }).default === 'object'
  )
}

/**
 * Generic config-file loader factory: probes candidate names under `baseDir`
 * (or the cwd), evaluates the first hit via jiti, unwraps a default export
 * and requires an object export (`ConfigError` otherwise). Every load is
 * fresh — jiti's mtime-granular caches are off and the native require-cache
 * entry is purged — so successive loads in one process (watch mode, tests)
 * always observe edits. Returns undefined when no candidate file exists.
 */
export function createConfigLoader<T>(options: ConfigLoaderOptions): ConfigLoader<T> {
  const { names, alias } = options

  return (baseDir?: string, explicitFile?: string): LoadedConfig<T> | undefined => {
    const root = path.resolve(baseDir ?? process.cwd())
    // fsCache is mtime-granular (same-second edits serve a stale transform)
    // and moduleCache/require.cache are keyed by path alone — all three must
    // go for "every load observes edits" to hold.
    const jiti = createJiti(import.meta.url, {
      alias,
      fsCache: false,
      moduleCache: false,
    })

    const candidates = explicitFile === undefined ? names : [explicitFile]

    for (const name of candidates) {
      const file = path.resolve(root, name)

      let resolved: string

      try {
        resolved = require.resolve(file)
      } catch {
        continue
      }

      // jiti delegates .js/.mjs evaluation to the native require — Node's
      // module cache is keyed by path and never checks mtime, so rapid
      // successive loads would see a stale config without this purge.
      delete (require.cache as Record<string, unknown>)[resolved]

      const loaded: unknown = jiti(file)

      const config = hasDefaultExport(loaded) ? loaded.default : loaded

      if (
        config === undefined ||
        config === null ||
        typeof config !== 'object' ||
        Array.isArray(config)
      ) {
        throw new ConfigError(`config file ${file} must export a config object`)
      }

      return { config: config as T, file }
    }

    return undefined
  }
}

// Self-entry for `import ... from 'deltic'` inside user configs: projects
// without a local deltic installation (global CLI, scratch dirs) still load.
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url)

  return here
    .replace(/config[/\\]load-config\.js$/, 'index.js')
    .replace(/config[/\\]load-config\.ts$/, 'index.ts')
}

// Loads the deltic config file (.ts/.mts/.js/.mjs) — the deltic-flavoured
// wrapper over `createConfigLoader`: standard file names, `deltic` self-alias,
// and the core validations (object export + `tasks`). The resolved file path
// is mirrored into `config.config` for ResolvedOptions.
export function loadConfig(
  baseDir?: string,
  explicitFile?: string,
): LoadedConfig<UserConfig> | undefined {
  const loader = createConfigLoader<UserConfig>({
    names: [
      'deltic.config.ts',
      'deltic.config.mts',
      'deltic.config.js',
      'deltic.config.mjs',
    ],
    alias: { deltic: selfEntry() },
  })

  const loaded = loader(baseDir, explicitFile)

  if (loaded === undefined) {
    return undefined
  }

  if (typeof loaded.config.tasks !== 'object' || loaded.config.tasks === null) {
    throw new ConfigError(`config file ${loaded.file} must declare "tasks"`)
  }

  return { config: { ...loaded.config, config: loaded.file }, file: loaded.file }
}
