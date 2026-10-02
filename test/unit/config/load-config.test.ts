import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError } from '../../../src/errors.js'
import {
  createConfigLoader,
  loadConfig,
} from '../../../src/config/load-config.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

async function makeDir(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'deltic-loadcfg-'))
  return dir
}

describe('loadConfig', () => {
  it('loads a TypeScript config with named export', async () => {
    const root = await makeDir()
    await writeFile(
      path.join(root, 'deltic.config.ts'),
      "export default { tasks: { js: { test: '**/*.js', use: ['js'] } } }",
    )

    const loaded = loadConfig(root)

    expect(loaded).toBeDefined()
    expect(loaded!.file).toBe(path.join(root, 'deltic.config.ts'))
    expect(loaded!.config.config).toBe(loaded!.file)
    expect(Object.keys(loaded!.config.tasks)).toEqual(['js'])
  })

  it('loads a config exported as default from an ESM file', async () => {
    const root = await makeDir()
    await writeFile(
      path.join(root, 'deltic.config.mjs'),
      "const config = { tasks: { js: { test: '**/*.js', use: ['js'] } } };\nexport default config;",
    )

    const loaded = loadConfig(root)

    expect(loaded!.file).toBe(path.join(root, 'deltic.config.mjs'))
  })

  it('unwraps a nested default export', async () => {
    const root = await makeDir()
    await writeFile(
      path.join(root, 'deltic.config.js'),
      "module.exports.default = { tasks: {} }",
    )

    const loaded = loadConfig(root)

    expect(loaded!.config.tasks).toEqual({})
  })

  it('rejects configs without tasks', async () => {
    const root = await makeDir()
    await writeFile(path.join(root, 'deltic.config.ts'), 'export default {}')

    expect(() => loadConfig(root)).toThrow(ConfigError)
  })

  it('rejects non-object exports', async () => {
    const root = await makeDir()
    await writeFile(path.join(root, 'deltic.config.ts'), 'export default 42')

    expect(() => loadConfig(root)).toThrow(ConfigError)
  })

  it('returns undefined when no config file exists', async () => {
    const root = await makeDir()
    await writeFile(path.join(root, 'unrelated.txt'), 'x')

    expect(loadConfig(root)).toBeUndefined()
  })
})

describe('createConfigLoader', () => {
  it('honours custom names and explicit files', async () => {
    const root = await makeDir()
    await writeFile(path.join(root, 'app.config.ts'), 'export default { v: 1 }')

    const loader = createConfigLoader<{ v: number }>({ names: ['app.config.ts'] })

    expect(loader(root)?.config).toEqual({ v: 1 })
    expect(loader(root, 'app.config.ts')?.config).toEqual({ v: 1 })
    expect(loader(root, 'missing.config.ts')).toBeUndefined()
  })

  it('reloads edited configs on successive loads', async () => {
    const root = await makeDir()
    const file = path.join(root, 'app.config.js')
    await writeFile(file, 'module.exports = { v: 1 }')

    const loader = createConfigLoader<{ v: number }>({ names: ['app.config.js'] })

    expect(loader(root)?.config).toEqual({ v: 1 })

    await writeFile(file, 'module.exports = { v: 2 }')

    expect(loader(root)?.config).toEqual({ v: 2 })
  })

  it('rejects non-object exports with a ConfigError', async () => {
    const root = await makeDir()
    await writeFile(path.join(root, 'app.config.js'), 'module.exports = 42')

    const loader = createConfigLoader({ names: ['app.config.js'] })

    expect(() => loader(root)).toThrow(ConfigError)
  })

  it('returns undefined when no candidate exists', async () => {
    const root = await makeDir()

    expect(createConfigLoader({ names: ['app.config.ts'] })(root)).toBeUndefined()
  })
})
