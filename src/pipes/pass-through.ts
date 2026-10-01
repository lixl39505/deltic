import { Transform } from 'streamx'

import { type StreamCallback } from './stream.js'

// An empty object-mode passthrough; useful as a placeholder in task chains.
export function passThroughPipe(): Transform {
  return new Transform({
    transform: (chunk: unknown, callback: StreamCallback) => {
      callback(null, chunk)
    },
  })
}
