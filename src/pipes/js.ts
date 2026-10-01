import type { Transform } from 'streamx'

import { es5ImportReg, es6ImportReg } from '../constants.js'
import type { EnvValue, Matcher } from '../types.js'
import { aliasPipe } from './alias.js'
import { dependPipe } from './depend.js'
import { envPipe } from './env.js'

export interface JsPipeOptions {
  /** Overrides the compiler-wide alias map for this task. */
  alias?: Record<string, string>
  /** Overrides the compiler-wide env values for this task. */
  env?: Record<string, EnvValue>
  /** Dependency matchers; defaults to the CommonJS + ESM import regexps. */
  matchers?: Matcher[]
}

// Alias replacement + env substitution + import dependency collection.
// Stages are returned individually so the task chain can profile each one.
export function jsPipe(options: JsPipeOptions = {}): Transform[] {
  return [
    aliasPipe(options.alias === undefined ? {} : { alias: options.alias }),
    envPipe(options.env === undefined ? {} : { env: options.env }),
    dependPipe({
      matchers: options.matchers ?? [es5ImportReg, es6ImportReg],
    }),
  ]
}
