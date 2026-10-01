import json5 from 'json5'
import type { Transform } from 'streamx'

import { createTransform } from './stream.js'

export interface StrJson5PipeOptions {
  space?: number
}

// Parses JSON5 content and re-serializes it as standard JSON.
export function strJson5Pipe(options: StrJson5PipeOptions = {}): Transform {
  const { space = 4 } = options

  return createTransform('str-json5', (file, next) => {
    const parsed: unknown = json5.parse(file.contents.toString('utf8'))

    file.contents = Buffer.from(JSON.stringify(parsed, null, space))
    next(null, file)
  })
}
