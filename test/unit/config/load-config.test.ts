import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError } from '../../../src/errors.js'
import { loadConfig } from '../../../src/config/load-config.js'

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
