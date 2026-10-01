import { Transform } from 'streamx'

import VinylPkg from 'vinyl'

import { CompileError } from '../errors.js'
import type { Vinyl } from '../types.js'

export type BufferVinyl = Vinyl & { contents: Buffer }

export type StreamCallback = (err: Error | null, data?: unknown) => void

export type PipeNext = StreamCallback

export function wrapPipeError(
  pipe: string,
  file: Vinyl,
  error: unknown,
): CompileError {
  if (error instanceof CompileError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)

  return new CompileError(`[${pipe}] ${message}`, { file: file.path, cause: error })
}

/**
 * Creates a vinyl object-mode transform with the shared pipe contract:
 * null files pass through untouched, streaming contents are rejected, and
 * thrown errors become CompileErrors tagged with the pipe name and file.
 */
export function createTransform(
  pipe: string,
  transform: (file: BufferVinyl, next: PipeNext) => void,
): Transform {
  return new Transform({
    transform: (chunk: unknown, callback: StreamCallback) => {
      const file = chunk as Vinyl

      if (typeof file?.isNull === 'function' && file.isNull()) {
        callback(null, file)
        return
      }

      if (typeof file?.isStream === 'function' && file.isStream()) {
        callback(
          wrapPipeError(pipe, file, new Error('streaming contents are not supported')),
        )
        return
      }

      try {
        transform(file as BufferVinyl, callback)
      } catch (error) {
        callback(wrapPipeError(pipe, file, error))
      }
    },
  })
}

export interface DerivedFileSpec {
  /** Absolute path of the derived file (must sit under the parent's base). */
  path: string
  contents: Buffer
}

/**
 * Creates a vinyl file derived from `parent` (e.g. an SFC slice, a route map,
 * or a less-vars artifact). The derived file inherits cwd/base and shares the
 * parent's file context, so dependency collection and output attribution keep
 * pointing at the original source. Emitted content must be final — derived
 * files flow through the remaining pipes and dest untouched.
 */
export function deriveFile(parent: Vinyl, spec: DerivedFileSpec): Vinyl {
  const derived = new VinylPkg({
    cwd: parent.cwd,
    base: parent.base,
    path: spec.path,
    contents: spec.contents,
  })

  const context = (parent as { context?: unknown }).context

  if (context !== undefined) {
    ;(derived as { context?: unknown }).context = context
  }

  return derived
}
