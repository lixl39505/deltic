import type { Transform } from 'streamx'

import type { FileContext, Matcher } from '../types.js'
import { createTransform } from './stream.js'

export interface DependPipeOptions {
  matchers?: Matcher[]
}

// Collects file dependencies via the dep-graph plugin. On failure the graph
// node is removed so the next run re-collects from scratch.
export function dependPipe(options: DependPipeOptions = {}): Transform {
  return createTransform('depend', (file, next) => {
    const context = file.context as FileContext

    try {
      context.depend!(file, { matchers: options.matchers })
    } catch (error) {
      context.removeGraphNodes!(file.path)
      throw error
    }

    next(null, file)
  })
}
