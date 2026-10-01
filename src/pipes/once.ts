import type { Transform } from 'streamx'

import type { CheckFileChangedResult, FileContext, Vinyl } from '../types.js'
import { createTransform } from './stream.js'

export interface OncePipeOptions {
  namespace?: string | ((file: Vinyl) => string)
  algorithm?: string
  hit?(file: Vinyl, result: CheckFileChangedResult): void
}

// Content-hash gate: unchanged files are dropped from the stream.
export function oncePipe(options: OncePipeOptions = {}): Transform {
  return createTransform('once', (file, next) => {
    const context = file.context as FileContext
    const result = context.checkFileChanged!(file, {
      namespace: options.namespace,
      algorithm: options.algorithm,
    })

    if (!result.changed) {
      options.hit?.(file, result)
      next(null, null)
      return
    }

    next(null, file)
  })
}
