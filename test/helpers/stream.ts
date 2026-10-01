import { Readable, Writable, type Transform } from 'streamx'
import { vi } from 'vitest'
import Vinyl from 'vinyl'

import type {
  FileContext,
  SessionContext,
  Vinyl as VinylType,
} from '../../src/types.js'

export interface RunResult {
  files: VinylType[]
  error: Error | null
}

export async function runStream(
  stream: Transform | Transform[],
  items: unknown[],
): Promise<RunResult> {
  const stages = Array.isArray(stream) ? stream : [stream]
  const out: VinylType[] = []
  let error: Error | null = null

  await new Promise<void>((resolve) => {
    const source = new Readable({ read: () => {} })
    const sink = new Writable({
      write: (chunk: unknown, callback: (err: Error | null) => void) => {
        out.push(chunk as VinylType)
        callback(null)
      },
    })
    const fail = (err: Error) => {
      error = err
      resolve()
    }

    source.on('error', fail)
    sink.on('error', fail)

    for (const stage of stages) {
      stage.on('error', fail)
    }

    source.pipe(stages[0]!)

    for (let i = 1; i < stages.length; i += 1) {
      stages[i - 1]!.pipe(stages[i]!)
    }

    stages.at(-1)!.pipe(sink)
    sink.on('finish', () => resolve())

    for (const item of items) {
      source.push(item)
    }

    source.push(null)
  })

  return { files: out, error }
}

export function makeFile(path: string, contents = '', base = '/project/src'): VinylType {
  return new Vinyl({
    base,
    path,
    contents: Buffer.from(contents),
  }) as unknown as VinylType
}

export function makeSession(): SessionContext {
  return {
    startTime: 0,
    endTime: -1,
    files: [],
    total: 0,
    totalCache: 0,
    totalHit: 0,
    profile: null,
  } as unknown as SessionContext
}

export type { VinylType }

export interface ContextOverrides {
  alias?: Record<string, string>
  env?: Record<string, string>
  depend?: (file: VinylType, options?: { matchers?: unknown[] }) => unknown
  addDep?: (file: VinylType, paths: string | readonly string[]) => void
  checkFileCached?: (file: VinylType) => boolean
  checkFileChanged?: (
    file: VinylType,
    settings?: unknown,
  ) => { changed: boolean; checksum: string }
  removeGraphNodes?: (paths: string | readonly string[]) => void
  withoutOptions?: boolean
}

export function makeContext(overrides: ContextOverrides = {}): FileContext {
  const options = overrides.withoutOptions
    ? undefined
    : {
        alias: overrides.alias ?? { '@': '/project/src', cdn: 'https://cdn.example.com' },
        env: overrides.env ?? { API: 'https://api.example.com' },
      }

  const session = makeSession()

  const context = {
    options,
    baseDir: '/project',
    sourceDir: '/project/src',
    outputDir: '/project/dist',
    cacheDir: '/project/.deltic',
    originalPath: '',
    customDeps: [] as string[],
    depended: false,
    session,
    depend: vi.fn(
      overrides.depend ??
        (() => ({ path: '', dependencies: [], requiredBy: [] })),
    ),
    addDep: vi.fn(overrides.addDep ?? (() => {})),
    removeGraphNodes: vi.fn(overrides.removeGraphNodes ?? (() => {})),
    checkFileCached: vi.fn(overrides.checkFileCached ?? (() => false)),
    checkFileChanged: vi.fn(
      overrides.checkFileChanged ?? (() => ({ changed: true, checksum: 'x' })),
    ),
  }

  return context as unknown as FileContext
}
