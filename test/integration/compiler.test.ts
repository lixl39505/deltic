import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Compiler } from '../../src/compiler.js'
import { SqliteState } from '../../src/store/sqlite-state.js'
import { createProject, type Project } from './helpers.js'
import type { SessionContext } from '../../src/types.js'

const FILES = {
  'js/entry.js':
    "import { lib } from '@/js/lib'\nexport const api = process.env.API_NAME\n",
  'js/lib.js': "export const lib = 'x'\n",
  'data/cfg.json': '{"name": "deltic"}',
  'data/cfg5.json5': '{num: 1, note: "x"}',
}

const CONFIG = {
  alias: { '@': './src' },
  env: { API_NAME: 'production-api' },
}

async function compile(
  project: Project,
  overrides: Partial<typeof CONFIG> = {},
): Promise<SessionContext> {
  const compiler = new Compiler(project.config({ ...CONFIG, ...overrides }))

  try {
    return await compiler.run()
  } finally {
    await compiler.stop()
  }
}

describe('compiler.run (full pipeline)', () => {
  it('compiles js/json/json5 through the preset tasks', async () => {
    const project = await createProject(FILES)
    const session = await compile(project)

    expect(session.total).toBe(4)
    expect(session.files.sort()).toEqual([
      path.join(project.srcDir, 'data/cfg.json'),
      path.join(project.srcDir, 'data/cfg5.json5'),
      path.join(project.srcDir, 'js/entry.js'),
      path.join(project.srcDir, 'js/lib.js'),
    ].map((p) => p).sort())

    // alias + env applied
    const entry = await project.read(path.join('js', 'entry.js'))
    expect(entry).toContain('from \'./lib\'')
    expect(entry).toContain('"production-api"')
    expect(entry).not.toContain('process.env')

    // json5 normalized
    const cfg5 = await project.read(path.join('data', 'cfg5.json5'))
    expect(cfg5).toBe('{\n    "num": 1,\n    "note": "x"\n}')

    // json kept but env untouched
    const cfg = await project.read(path.join('data', 'cfg.json'))
    expect(cfg).toBe('{"name": "deltic"}')

    expect(project.lines.some((line) => line.includes('Compiling Time'))).toBe(true)
  }, 20000)

  it('hits the compile cache on the second run and persists state', async () => {
    const project = await createProject(FILES)

    const first = await compile(project)
    expect(first.totalHit).toBe(0)

    const second = await compile(project)
    expect(second.totalHit).toBe(second.total)
    expect(second.files).toHaveLength(0)

    const state = new SqliteState({
      file: path.join(project.root, '.deltic', 'state.db'),
    })

    expect(state.meta.get('version', '')).toBe(
      (await import('../../package.json', { with: { type: 'json' } })).default.version,
    )
    expect(Object.keys(state.compiled.all()).length).toBeGreaterThan(0)
    expect(Object.keys(state.checksums.all()).length).toBeGreaterThan(0)
    expect(state.files.all().length).toBeGreaterThan(0)
    expect(Object.keys(state.graph.all()).length).toBeGreaterThan(0)
    expect(state.meta.get('env', {})).toEqual({
      API_NAME: 'production-api',
      mode: 'development',
    })

    state.close()
  }, 20000)

  it('recompiles when the resolved env changes', async () => {
    const project = await createProject(FILES)

    const first = await compile(project, { env: { API_NAME: 'one' } })
    expect(first.totalHit).toBe(0)

    const second = await compile(project, { env: { API_NAME: 'one' } })
    expect(second.totalHit).toBe(second.total)

    const third = await compile(project, { env: { API_NAME: 'two' } })

    // only entry.js references the env variable — lib.js stays cached
    expect(third.totalHit).toBe(third.total - 1)
    expect(third.files).toHaveLength(1)

    const entry = await project.read(path.join('js', 'entry.js'))
    expect(entry).toContain('"two"')
  }, 20000)

  it('keeps multiple instances isolated', async () => {
    const a = await createProject(FILES)
    const b = await createProject(FILES)

    const compilerA = new Compiler(a.config(CONFIG))
    const compilerB = new Compiler(b.config(CONFIG))

    const events: string[] = []
    compilerA.on('afterCompile', () => {
      events.push('a')
    })
    compilerB.on('afterCompile', () => {
      events.push('b')
    })

    const sessionA = await compilerA.run()
    const sessionB = await compilerB.run()

    expect(events).toEqual(['a', 'b'])
    expect(sessionA.total).toBe(4)
    expect(sessionB.total).toBe(4)

    // instance pipe registries are independent
    compilerA.setPipe('only-a', () => {
      throw new Error('should not run in B')
    })
    expect(compilerA.getPipe('only-a')).toBeDefined()
    expect(compilerB.getPipe('only-a')).toBeUndefined()

    await compilerA.stop()
    await compilerB.stop()
  }, 20000)

  it('collects a dependency graph across runs', async () => {
    const project = await createProject(FILES)

    await compile(project)

    const state = new SqliteState({
      file: path.join(project.root, '.deltic', 'state.db'),
    })
    const graph = state.graph.all()
    state.close()
    // dep-graph ids keep platform separators under a leading one
    const fileId = (p: string): string => path.sep + path.relative(project.srcDir, p)

    const entryId = fileId(path.join(project.srcDir, 'js/entry.js'))
    const libId = fileId(path.join(project.srcDir, 'js/lib.js'))

    expect(graph[entryId]!.dependencies).toContain(libId)
    expect(graph[libId]!.requiredBy).toContain(entryId)
  }, 20000)

  it('supports profiled runs', async () => {
    const project = await createProject(FILES)
    const compiler = new Compiler(
      project.config({ ...CONFIG, profile: true }),
    )

    const session = await compiler.run()

    expect(session.profile).not.toBeNull()
    expect(session.profile!.pipes.length).toBeGreaterThan(0)
    expect(session.profile!.files.length).toBeGreaterThan(0)
    expect(project.lines.some((line) => line.startsWith('Profile: total'))).toBe(true)

    await compiler.stop()
  }, 20000)

  it('does not write output when a task opts out', async () => {
    const project = await createProject(FILES)
    const compiler = new Compiler(
      project.config({
        ...CONFIG,
        tasks: {
          js: { test: '**/*.js', use: ['js'], output: false },
        },
      }),
    )

    const session = await compiler.run()

    expect(session.total).toBe(2)
    expect(existsSync(project.distDir)).toBe(false)

    await compiler.stop()
  }, 20000)
  it('pre-filter keeps vanished files as misses and surfaces the read error', async () => {
    const project = await createProject(FILES)
    const compiler = new Compiler(project.config(CONFIG))

    compiler.on('beforeCompile', async () => {
      // delete after scan, before the pre-filter stats it
      const fs = await import('node:fs/promises')
      await fs.rm(path.join(project.srcDir, 'js', 'lib.js'), { force: true })
    })

    await expect(compiler.run()).rejects.toThrowError()

    await compiler.stop().catch(() => {})
  }, 20000)
})
