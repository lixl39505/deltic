import type { Transform } from 'streamx'

import type { FileContext, Vinyl } from '../types.js'
import { createTransform } from './stream.js'

export interface DepAddPipeOptions {
  paths:
    | string
    | readonly string[]
    | ((file: Vinyl, context: FileContext) => string[])
}

// Manually appends dependencies. Must run after `depend`, which resets the
// dependency list per file.
export function depAddPipe(options: DepAddPipeOptions): Transform {
  return createTransform('dep-add', (file, next) => {
    const context = file.context as FileContext
    const paths =
      typeof options.paths === 'function'
        ? options.paths(file, context)
        : options.paths

    context.addDep!(file, paths)
    next(null, file)
  })
}
