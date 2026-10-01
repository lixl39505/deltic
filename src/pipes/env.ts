import path from 'node:path'
import type { Transform } from 'streamx'

import type { EnvValue, FileContext } from '../types.js'
import { createTransform } from './stream.js'

export interface EnvPipeOptions {
  /** Values to substitute; falls back to `options.env` from the compile context. */
  env?: Record<string, EnvValue>
  pattern?: RegExp
  /** What an undefined variable becomes; 'keep' leaves the source untouched. */
  missing?: 'undefined' | 'null' | 'keep'
}

const DEFAULT_PATTERN = /process\.env\.([_a-zA-Z][_a-zA-Z0-9]*)/g

// Replaces process.env.X references with literal values and records a
// pseudo-dependency (`.env/X`) so cache invalidation can watch env changes.
export function envPipe(options: EnvPipeOptions = {}): Transform {
  const { pattern = DEFAULT_PATTERN, missing = 'undefined' } = options

  return createTransform('env', (file, next) => {
    const context = file.context as FileContext
    const env = options.env ?? context.options.env
    const content = file.contents
      .toString('utf8')
      .replace(pattern, (match: string, name: string) => {
        const value = env[name]

        if (value !== undefined) {
          context.customDeps.push(path.resolve(context.sourceDir, `.env/${name}`))
          return JSON.stringify(value)
        }

        if (missing === 'keep') {
          return match
        }

        context.customDeps.push(path.resolve(context.sourceDir, `.env/${name}`))
        return missing === 'null' ? 'null' : 'undefined'
      })

    file.contents = Buffer.from(content)
    next(null, file)
  })
}
