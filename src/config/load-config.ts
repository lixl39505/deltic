import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

import { ConfigError } from '../errors.js'
import type { UserConfig } from '../types.js'

export interface LoadedConfig {
  config: UserConfig
  file: string
}

const require = createRequire(import.meta.url)

const CONFIG_NAMES = [
  'deltic.config.ts',
  'deltic.config.mts',
  'deltic.config.js',
  'deltic.config.mjs',
]

function hasDefaultExport(value: unknown): value is { default: UserConfig } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    typeof (value as { default: unknown }).default === 'object'
  )
}

// Self-entry for `import ... from 'deltic'` inside user configs: projects
// without a local deltic installation (global CLI, scratch dirs) still load.
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url)

  return here
    .replace(/config[/\\]load-config\.js$/, 'index.js')
    .replace(/config[/\\]load-config\.ts$/, 'index.ts')
}

// Loads the deltic config file (.ts/.mts/.js/.mjs) via jiti — either the
// explicitly named file or the first standard name found in the directory.
// Returns undefined when no config file exists; throws ConfigError on
// invalid exports.
export function loadConfig(baseDir?: string, explicitFile?: string): LoadedConfig | undefined {
  const root = path.resolve(baseDir ?? process.cwd())
  const jiti = createJiti(import.meta.url, {
    alias: { deltic: selfEntry() },
  })

  const names = explicitFile === undefined ? CONFIG_NAMES : [explicitFile]

  for (const name of names) {
    const file = path.resolve(root, name)

    try {
      require.resolve(file)
    } catch {
      continue
    }

    const loaded: unknown = jiti(file)

    const config =
      hasDefaultExport(loaded) ? (loaded.default as UserConfig) : (loaded as UserConfig)

    if (
      config === undefined ||
      config === null ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      throw new ConfigError(`config file ${file} must export a config object`)
    }

    if (typeof config.tasks !== 'object' || config.tasks === null) {
      throw new ConfigError(`config file ${file} must declare "tasks"`)
    }

    return { config: { ...config, config: file }, file }
  }

  return undefined
}
