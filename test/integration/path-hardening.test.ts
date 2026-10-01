import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Compiler } from '../../src/compiler.js'
import { createProject } from './helpers.js'

// CI workspaces routinely contain glob-magic characters (`job(3)`, `[win]`).
// Every literal path the compiler embeds into a pattern must be escaped, or
// scans silently match nothing.
const MAGIC = 'job(3) [x]'

describe('path hardening', () => {
  it('compiles a project living under a glob-magic directory', async () => {
    const project = await createProject(
      {
        'js/entry.js': "import { lib } from '@/js/lib'\nexport const api = process.env.API_NAME\n",
        'js/lib.js': "export const lib = 'v1'\n",
        'data/cfg.json5': '{n: 1}',
      },
      {},
      MAGIC,
    )

    const compiler = new Compiler(
      project.config({
        alias: { '@': './src' },
        env: { API_NAME: 'api' },
        profile: true,
      }),
    )

    try {
      const session = await compiler.run()

      expect(session.total).toBe(3)
      expect(await project.read(path.join('js', 'entry.js'))).toContain(
        "from './lib'",
      )
      expect(await project.read(path.join('js', 'lib.js'))).toBe(
        "export const lib = 'v1'\n",
      )
      expect(await project.read(path.join('data', 'cfg.json5'))).toBe(
        '{\n    "n": 1\n}',
      )

      // cleanExpired against the magic directory reports nothing stale
      const cleanExpired = compiler.capability('cleanExpired')
      expect(await cleanExpired?.()).toEqual([])

      // single-file increments still target exactly one file
      const batches: unknown[] = []
      compiler.on('afterCompile', ({ session: batch }) => {
        batches.push(batch.total)
      })

      await compiler.incrementCompile([
        path.join(project.srcDir, 'js', 'lib.js'),
      ])

      // lib is imported by entry → compileAncestor rebuilds both
      expect(batches).toEqual([2])
    } finally {
      await compiler.stop()
    }
  }, 30000)

  it('cleans artifacts when a magic-named source disappears', async () => {
    const project = await createProject(
      {
        'js/doomed.js': 'export const doomed = 1\n',
        'js/stays.js': 'export const stays = 1\n',
      },
      {},
      MAGIC,
    )

    const compiler = new Compiler(project.config())
    await compiler.run()

    expect(project.has(path.join('js', 'doomed.js'))).toBe(true)

    const { rm } = await import('node:fs/promises')
    await rm(path.join(project.srcDir, 'js', 'doomed.js'))

    const expired = await compiler.capability('cleanExpired')?.()

    expect(expired).toEqual([
      path
        .join(project.srcDir, 'js', 'doomed.js')
        .split(path.sep)
        .join('/'),
    ])
    expect(project.has(path.join('js', 'doomed.js'))).toBe(false)
    expect(project.has(path.join('js', 'stays.js'))).toBe(true)

    await compiler.stop()
  }, 30000)
})
