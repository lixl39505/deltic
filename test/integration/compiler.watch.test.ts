import path from 'node:path'
import { rm } from 'node:fs/promises'
import { Transform } from 'streamx'
import { describe, expect, it } from 'vitest'

import { Compiler } from '../../src/compiler.js'
import { createProject, type Project } from './helpers.js'
import type { SessionContext } from '../../src/types.js'

const FILES = {
  'js/entry.js': "import { lib } from './lib'\nexport const api = process.env.API_NAME\n",
  'js/lib.js': "export const lib = 'v1'\n",
}

const CONFIG = {
  alias: { '@': './src' },
  env: { API_NAME: 'api' },
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now()

  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out')
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
}

function batchesOf(compiler: Compiler): SessionContext[] {
  const batches: SessionContext[] = []

  compiler.on('afterCompile', ({ session }) => {
    batches.push(session)
  })

  return batches
}

describe('compiler.watch', () => {
  it('recompiles changed files and cleans deleted ones', async () => {
    const project: Project = await createProject(FILES)
    const compiler = new Compiler(project.config(CONFIG))

    const batches = batchesOf(compiler)

    await compiler.watch()

    // change: lib is rewritten, upstream entry recompiles too
    await project.write({ 'js/lib.js': "export const lib = 'watched'\n" })

    await waitUntil(async () => {
      try {
        return (await project.read(path.join('js', 'lib.js'))).includes('watched')
      } catch {
        return false
      }
    })

    await waitUntil(() => batches.at(-1) !== undefined && batches.at(-1)!.total >= 1)

    // delete: the artifact disappears and the clean hook fires
    await rm(path.join(project.srcDir, 'js', 'lib.js'))
    await project.write({ 'js/keep.txt': '' })
    await waitUntil(async () => {
      try {
        await project.read(path.join('js', 'lib.js'))
        return false
      } catch {
        return true
      }
    })

    await waitUntil(() => batches.at(-1)!.endTime > 0)

    await compiler.stop()

    expect(project.has(path.join('js', 'lib.js'))).toBe(false)
  }, 30000)
})

describe('error paths', () => {
  it('routes pipe failures through taskError and drops the cache record', async () => {
    const project = await createProject(FILES)

    // first pass populates the cache
    const warmup = new Compiler(project.config(CONFIG))
    await warmup.run()
    await warmup.stop()

    const errors: unknown[] = []
    const failing = new Compiler(
      project.config({
        ...CONFIG,
        pipes: {
          boom: () =>
            new Transform({
              transform: (
                chunk: unknown,
                cb: (err: Error | null, data?: unknown) => void,
              ) => {
                const file = chunk as { path: string }

                if (
                  typeof file.path === 'string' &&
                  file.path.endsWith('lib.js')
                ) {
                  cb(new Error('synthetic failure'))
                  return
                }

                cb(null, chunk)
              },
            }),
        },
        tasks: {
          js: { test: '**/*.js', use: [['boom', {}]], compileAncestor: true },
        },
      }),
    )

    failing.on('taskError', ({ error }) => {
      errors.push(error)
    })

    await expect(failing.run()).rejects.toThrowError(/synthetic failure/)
    expect(errors).toHaveLength(1)

    await failing.stop()
  }, 20000)

  it('rejects concurrent runs', async () => {
    const project = await createProject(FILES)
    const compiler = new Compiler(project.config(CONFIG))

    await compiler.ready

    const first = compiler.run()

    await expect(compiler.run()).rejects.toThrowError(/already running/)

    await first
    await compiler.stop()
  }, 20000)
})
