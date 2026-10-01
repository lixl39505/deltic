import type {
  Readable as StreamxReadable,
  Transform as StreamxTransform,
  Writable as StreamxWritable,
} from 'streamx'

// @ts-expect-error -- gulp 5 ships no type declarations
import gulp, { dest, series, src } from 'gulp'

export interface PipeSource {
  pipe(destination: unknown, ...rest: unknown[]): unknown
  on(event: string, listener: (...args: never[]) => void): unknown
}

export type GulpTaskFn = (done: (err?: Error | null) => void) => void

// vinyl-fs 4 is streamx-based: its src/dest return streamx streams, so the
// untyped-gulp cast lives here once and everything downstream keeps real
// streamx types.
export const gulpSrc = src as unknown as (
  globs: readonly string[],
  options?: Record<string, unknown>,
) => StreamxReadable

export const gulpDest = dest as unknown as (
  dir: string,
  options?: Record<string, unknown>,
) => StreamxTransform

export const gulpSeries = series as unknown as (
  ...tasks: (GulpTaskFn | (() => unknown))[]
) => GulpTaskFn

let gulpErrorHandled = false
let gulpErrorHandler: ((error: unknown) => void) | undefined

// Undertaker emits task errors on the gulp instance itself; without a
// listener they escape as uncaught exceptions even when the caller already
// handles the rejection through the series callback.
export function installGulpErrorHandler(
  handler: (error: unknown) => void,
): void {
  // keep the handler fresh per compiler; the gulp listener is attached once
  gulpErrorHandler = handler

  if (gulpErrorHandled) {
    return
  }

  gulpErrorHandled = true
  ;(gulp as unknown as PipeSource).on('error', (error: unknown) => {
    gulpErrorHandler?.(error)
  })
}

/** Forwards an error through the installed gulp error handler (test hook). */
export function dispatchGulpError(error: unknown): void {
  gulpErrorHandler?.(error)
}
