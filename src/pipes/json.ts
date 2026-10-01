import type { Transform } from 'streamx'

import type { EnvValue, Matcher } from '../types.js'
import { dependPipe } from './depend.js'
import { envPipe } from './env.js'
import { strJson5Pipe } from './str-json5.js'

export interface JsonPipeOptions {
  env?: Record<string, EnvValue>
  /** Parse the content as JSON5 and re-serialize as standard JSON. */
  json5?: boolean
  /** Dependency matchers; defaults to none (no implicit conventions). */
  matchers?: Matcher[]
}

// Env substitution + optional JSON5 normalization + dependency collection.
// Stages are returned individually so the task chain can profile each one.
export function jsonPipe(options: JsonPipeOptions = {}): Transform[] {
  const stages: Transform[] = [
    envPipe(options.env === undefined ? {} : { env: options.env }),
  ]

  if (options.json5 === true) {
    stages.push(strJson5Pipe())
  }

  stages.push(dependPipe({ matchers: options.matchers ?? [] }))

  return stages
}

export function json5Pipe(
  options: Omit<JsonPipeOptions, 'json5'> = {},
): Transform[] {
  return jsonPipe({ ...options, json5: true })
}
