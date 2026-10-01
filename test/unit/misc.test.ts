import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { relativeId } from '../../src/plugins/dep-graph.js'
import { loadEnvFiles } from '../../src/config/env.js'
import { loadConfig } from '../../src/config/load-config.js'
import { preset } from '../../src/preset/index.js'
import { aliasPipe } from '../../src/pipes/alias.js'
import { defineConfig } from '../../src/config/define-config.js'
import { makeContext, makeFile, runStream } from '../helpers/stream.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('defineConfig', () => {
  it('returns the identical config object', () => {
    const config = { tasks: {} }

    expect(defineConfig(config)).toBe(config)
  })
})

describe('relativeId edges', () => {
  it('maps the base itself to the separator', () => {
    const base = path.resolve('/project/src')

    expect(relativeId(base, base)).toBe(path.sep)
  })

  it('keeps paths outside the base absolute', () => {
    const id = relativeId(
      path.resolve('/project/other/a.js'),
      path.resolve('/project/src'),
    )

    expect(id).toBe(path.resolve('/project/other/a.js'))
  })
})

describe('preset extras', () => {
  it('ignores extras disabled with false', () => {
    const tasks = preset({ extra: false })

    expect(tasks.extra).toBeUndefined()
    expect(Object.keys(tasks)).toContain('js')
  })
})

describe('alias map partial prefix', () => {
  it('leaves requests whose slash-prefix is not a key untouched', async () => {
    const file = makeFile(path.resolve('/project/src/a.js'), "import x from '@app/y'\n")
    file.context = makeContext({ alias: { '@': path.resolve('/project/src'), app: path.resolve('/project/src') } })

    const { files, error } = await runStream(
      aliasPipe({ alias: { '@': path.resolve('/project/src'), app: path.resolve('/project/src') } }),
      [file],
    )

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe("import x from '@app/y'\n")
  })
})

describe('env loading without a mode', () => {
  it('reads only the modeless files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-envnomode-'))
    await writeFile(path.join(dir, '.env'), 'A=1')
    await writeFile(path.join(dir, '.env.local'), 'B=2')

    expect(loadEnvFiles(dir)).toEqual({ A: '1', B: '2' })
  })
})

describe('loadConfig guards', () => {
  it('rejects array exports', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-loadcfg2-'))
    await writeFile(path.join(dir, 'deltic.config.ts'), 'export default []')

    expect(() => loadConfig(dir)).toThrow(/config object/)
  })

  it('returns undefined for an explicit file that does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-loadcfg3-'))

    expect(loadConfig(dir, 'nope.config.ts')).toBeUndefined()
  })
})

describe('loadConfig defaults to cwd', () => {
  it('finds nothing when cwd has no config file', async () => {
    const previous = process.cwd()
    const empty = await mkdtemp(path.join(tmpdir(), 'deltic-cwd-'))

    process.chdir(empty)

    try {
      expect(loadConfig()).toBeUndefined()
    } finally {
      process.chdir(previous)
      await rm(empty, { recursive: true, force: true })
    }
  })
})
