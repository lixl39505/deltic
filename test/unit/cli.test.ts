import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/cli.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function makeDeps() {
  const out: string[] = []
  const errors: string[] = []

  return {
    out,
    errors,
    deps: {
      cwd: () => dir!,
      write: (message: string) => out.push(message),
      error: (message: string) => errors.push(message),
      attachSignals: false,
    },
  }
}

async function scaffoldProject(): Promise<void> {
  await mkdir(path.join(dir!, 'src'), { recursive: true })
  await writeFile(
    path.join(dir!, 'deltic.config.ts'),
    [
      "import { defineConfig, preset } from 'deltic'",
      'export default defineConfig({',
      '  tasks: preset({ assets: false }),',
      '  progress: false,',
      '})',
    ].join('\n'),
  )
  await writeFile(path.join(dir!, 'src', 'a.js'), 'export const a = 1\n')
}

describe('runCli', () => {
  it('prints the package version', async () => {
    const { deps, out } = makeDeps()
    const code = await runCli(['--version'], {
      ...deps,
      version: '9.9.9-test',
    })

    expect(code).toBe(0)
    expect(out).toContain('9.9.9-test')
  })

  it('init creates a config template', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cli-'))
    const { deps, out } = makeDeps()

    const code = await runCli(['init'], deps)

    expect(code).toBe(0)
    expect(existsSync(path.join(dir!, 'deltic.config.ts'))).toBe(true)
    expect(out.some((line) => line.includes('created'))).toBe(true)
  })

  it('init refuses to overwrite an existing config', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cli-'))
    const { deps, errors } = makeDeps()

    await runCli(['init'], deps)
    const code = await runCli(['init'], deps)

    expect(code).toBe(1)
    expect(errors.some((line) => line.includes('already exists'))).toBe(true)
  })

  it('reports a missing config for build', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cli-'))
    const { deps, errors } = makeDeps()

    const code = await runCli(['build'], deps)

    expect(code).toBe(1)
    expect(errors.some((line) => line.includes('deltic init'))).toBe(true)
  })

  it('builds a project end to end', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cli-'))
    await scaffoldProject()

    const { deps } = makeDeps()
    const code = await runCli(['build'], deps)

    expect(code).toBe(0)
    expect(existsSync(path.join(dir!, 'dist', 'a.js'))).toBe(true)
  }, 30000)

  it('builds with a custom config name and flags', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cli-'))
    await mkdir(path.join(dir!, 'src'), { recursive: true })
    await writeFile(
      path.join(dir!, 'special.config.ts'),
      [
        "import { defineConfig, preset } from 'deltic'",
        'export default defineConfig({',
        '  tasks: preset({ assets: false, js: false }),',
        '  progress: false,',
        '})',
      ].join('\n'),
    )
    await writeFile(path.join(dir!, 'src', 'a.js'), 'export const a = 1\n')

    const { deps } = makeDeps()
    const code = await runCli(
      ['build', '--config', 'special.config.ts', '--profile', '--no-cache'],
      deps,
    )

    // js disabled → nothing to output, but the run must succeed
    expect(code).toBe(0)
    expect(existsSync(path.join(dir!, 'dist', 'a.js'))).toBe(false)
  }, 30000)
})
