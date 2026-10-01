import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// True end-to-end: the built CLI runs as a subprocess against real temp
// projects. Config files import 'deltic' and resolve through the repo's
// package self-reference, so consumer resolution is exercised too.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..', '..')
const CLI = path.join(REPO, 'bin', 'deltic.js')

const CONFIG = [
  "import { defineConfig, preset } from 'deltic'",
  'export default defineConfig({',
  "  alias: { '@': './src' },",
  "  env: { API_NAME: 'e2e-api' },",
  '  tasks: preset({ assets: false }),',
  '  progress: false,',
  '})',
].join('\n')

const FILES: Record<string, string> = {
  'src/js/entry.js':
    "import { lib } from '@/js/lib'\nexport const api = process.env.API_NAME\n",
  'src/js/lib.js': "export const lib = 'v1'\n",
}

const roots: string[] = []

async function makeProject(name: string, withConfig = true): Promise<string> {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'deltic-e2e-')), name)
  roots.push(root)

  await mkdir(path.join(root, 'src', 'js'), { recursive: true })
  await writeFile(path.join(root, 'src', 'js', 'entry.js'), FILES['src/js/entry.js']!)
  await writeFile(path.join(root, 'src', 'js', 'lib.js'), FILES['src/js/lib.js']!)

  if (withConfig) {
    await writeFile(path.join(root, 'deltic.config.ts'), CONFIG)
  }

  return root
}

function run(
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''

    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })

    const timer = setTimeout(() => {
      child.kill()
    }, timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  everyMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await probe()) {
      return
    }

    await new Promise((resolve) => {
      setTimeout(resolve, everyMs)
    })
  }

  throw new Error('waitFor timed out')
}

const readDist = (root: string, rel: string) =>
  readFile(path.join(root, 'dist', rel), 'utf8')

const hasDist = (root: string, rel: string) =>
  existsSync(path.join(root, 'dist', rel))

beforeAll(() => {
  execSync('pnpm build', { cwd: REPO, stdio: 'pipe' })
})

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
      retryDelay: 200,
      maxRetries: 5,
    })
  }
})

describe('e2e · build', () => {
  it('init creates a usable config', async () => {
    const root = await makeProject('basic', false)

    const init = await run(['init'], root)
    expect(init.code).toBe(0)
    expect(existsSync(path.join(root, 'deltic.config.ts'))).toBe(true)

    // the generated config must build as-is (assets passthrough overlaps js,
    // so every file is processed by two tasks)
    const build = await run(['build'], root)
    expect(build.code).toBe(0)
    expect(hasDist(root, path.join('js', 'entry.js'))).toBe(true)
  }, 120_000)

  it('build compiles, second build is fully cached', async () => {
    const root = await makeProject('basic')

    const first = await run(['build'], root)
    expect(first.code).toBe(0)
    expect(first.out).toContain('0/2 file skipped')

    const entry = await readDist(root, path.join('js', 'entry.js'))
    expect(entry).toContain("from './lib'")
    expect(entry).toContain('"e2e-api"')

    const second = await run(['build'], root)
    expect(second.code).toBe(0)
    expect(second.out).toContain('2/2 file skipped')
  }, 120_000)

  it('picks up source changes on the next build', async () => {
    const root = await makeProject('watch-build')
    expect((await run(['build'], root)).code).toBe(0)

    await writeFile(path.join(root, 'src', 'js', 'lib.js'), "export const lib = 'v2'\n")

    const second = await run(['build'], root)
    expect(second.code).toBe(0)
    expect(await readDist(root, path.join('js', 'lib.js'))).toContain('v2')
    // entry.js is unchanged → served from cache
    expect(second.out).toContain('1/2 file skipped')
  }, 120_000)

  it('removes artifacts of deleted sources', async () => {
    const root = await makeProject('delete')
    expect((await run(['build'], root)).code).toBe(0)
    expect(hasDist(root, path.join('js', 'lib.js'))).toBe(true)

    await rm(path.join(root, 'src', 'js', 'lib.js'))

    const second = await run(['build'], root)
    expect(second.code).toBe(0)
    expect(second.out).toContain('was deleted')
    expect(hasDist(root, path.join('js', 'lib.js'))).toBe(false)
    expect(hasDist(root, path.join('js', 'entry.js'))).toBe(true)
  }, 120_000)

  it('--profile prints the slowest pipes and files', async () => {
    const root = await makeProject('profile')

    const result = await run(['build', '--profile'], root)

    expect(result.code).toBe(0)
    expect(result.out).toContain('Profile (pipes by total)')
    expect(result.out).toContain('Profile (files by total)')
  }, 120_000)

  it('--no-cache rebuilds every file', async () => {
    const root = await makeProject('nocache')

    await run(['build'], root)

    const second = await run(['build', '--no-cache'], root)
    expect(second.code).toBe(0)
    expect(second.out).toContain('0/2 file skipped')
  }, 120_000)

  it('fails with exit code 1 when the config is missing', async () => {
    const root = await makeProject('noconfig', false)

    const result = await run(['build'], root)

    expect(result.code).toBe(1)
    expect(result.err).toContain('deltic init')
  }, 60_000)
})

describe('e2e · dev', () => {
  it('compiles on start, recompiles on change, exits on SIGINT', async () => {
    const root = await makeProject('dev')

    const child = spawn(process.execPath, [CLI, 'dev'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    try {
      // initial compile
      await waitFor(
        async () => hasDist(root, path.join('js', 'lib.js')) && (await readDist(root, path.join('js', 'lib.js'))).includes('v1'),
        30_000,
      )

      // incremental recompile on change
      await writeFile(path.join(root, 'src', 'js', 'lib.js'), "export const lib = 'v2'\n")
      await waitFor(
        async () => (await readDist(root, path.join('js', 'lib.js'))).includes('v2'),
        30_000,
      )
      // entry.js was not part of this change and keeps its compiled content
      expect(await readDist(root, path.join('js', 'entry.js'))).toContain('"e2e-api"')

      // file deletion cleans the artifact
      await rm(path.join(root, 'src', 'js', 'lib.js'))
      await waitFor(() => !hasDist(root, path.join('js', 'lib.js')), 30_000)
    } catch (error) {
      child.kill()
      throw new Error(
        `dev flow failed: ${(error as Error).message}\nstdout:\n${out}\nstderr:\n${stderr}`,
      )
    }

    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve())
    })
    child.kill('SIGINT')

    const exitedBeforeTimeout = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 10_000)
      }),
    ])

    expect(exitedBeforeTimeout).toBe(true)
    expect(stderr).not.toContain('Unhandled')
  }, 120_000)
})
