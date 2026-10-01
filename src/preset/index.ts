import type { TaskConfig, UserConfig } from '../types.js'

export interface PresetOverrides {
  js?: Partial<TaskConfig> | false
  json?: Partial<TaskConfig> | false
  json5?: Partial<TaskConfig> | false
  /** Copies every other source file straight to the output directory. */
  assets?: Partial<TaskConfig> | false
  [task: string]: TaskConfig | Partial<TaskConfig> | false | undefined
}

const BASE_TASKS: Record<string, TaskConfig> = {
  js: { test: '**/*.js', use: ['js'], compileAncestor: true },
  json: { test: '**/*.json', use: ['json'] },
  json5: { test: '**/*.json5', use: ['json5'] },
  assets: { test: '**/*', use: ['pass-through'] },
}

/**
 * The recommended mechanism-only task set. Spread it into your config:
 *
 * ```ts
 * defineConfig({ tasks: preset() })
 * ```
 *
 * Pass `false` for a task to drop it, or a TaskConfig to override it.
 */
export function preset(
  overrides: PresetOverrides = {},
): UserConfig['tasks'] {
  const tasks: UserConfig['tasks'] = {}

  for (const [name, config] of Object.entries(BASE_TASKS)) {
    const override = overrides[name]

    if (override === false) {
      continue
    }

    tasks[name] = override === undefined ? { ...config } : { ...config, ...override }
  }

  for (const [name, config] of Object.entries(overrides)) {
    if (name in BASE_TASKS || config === false || config === undefined) {
      continue
    }

    tasks[name] = config as TaskConfig
  }

  return tasks
}
