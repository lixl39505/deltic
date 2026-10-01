import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { main, runCli } from '../../src/cli.js'
import type { Compiler } from '../../src/compiler.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

async function scaffold(): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), 'deltic-clidev-'))
  await mkdir(path.join(dir!, 'src'), { recursive: true })
  await writeFile(
    path.join(dir!, 'deltic.config.ts'),
    [
      "import { defineConfig, preset } from 'deltic'",
      'export default defineConfig({',
      '  tasks: preset({ assets: false, json: false, json5: false }),',
      '  progress: false,',
      '})',
    ].join('\n'),
  )
  await writeFile(path.join(dir!, 'src', 'a.js'), 'export const a = 1\n')
}

describe('runCli dev mode', () => {
  it('watches, recompiles on change and stops cleanly', async () => {
    await scaffold()

    let running: Compiler | undefined
    const errors: string[] = []

    const code = await runCli(['dev', '-m', 'testing'], {
      cwd: () => dir!,
      write: () => {},
      error: (message) => errors.push(message),
      attachSignals: false,
      onStart: (compiler) => {
        running = compiler
      },
    })

    expect(code).toBe(0)
    expect(running).toBeDefined()
    expect(existsSync(path.join(dir!, 'dist', 'a.js'))).toBe(true)
    expect(running!.options.mode).toBe('testing')

    await writeFile(path.join(dir!, 'src', 'a.js'), 'export const a = 2\n')

    const deadline = Date.now() + 8000

    while (Date.now() < deadline) {
      const content = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(dir!, 'dist', 'a.js'), 'utf8'),
      )

      if (content.includes('a = 2')) {
        break
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100)
      })
    }

    const content = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(dir!, 'dist', 'a.js'), 'utf8'),
    )

    expect(content).toContain('a = 2')

    await running!.stop()
    expect(errors).toEqual([])
  }, 30000)

  it('shuts down through injected signals', async () => {
    await scaffold()

    const listeners: Array<[string, () => void]> = []
    const signals = {
      once: (name: string, fn: () => void) => {
        listeners.push([name, fn])
      },
    }

    let running: Compiler | undefined

    const runPromise = runCli(['dev'], {
      cwd: () => dir!,
      write: () => {},
      error: () => {},
      signals,
      onStart: (compiler) => {
        running = compiler
      },
    })

    await vi.waitFor(() => {
      expect(running).toBeDefined()
      expect(listeners.length).toBe(2)
    })

    expect(listeners.map(([name]) => name).sort()).toEqual([
      'SIGINT',
      'SIGTERM',
    ])

    listeners[0]![1]()
    listeners[0]![1]() // second signal hits the stopping guard

    await expect(runPromise).resolves.toBe(0)
    expect(running).toBeDefined()
  }, 30000)

  it('falls back to process.cwd when deps.cwd is omitted', async () => {
    await scaffold()
    const previous = process.cwd()
    process.chdir(dir!)

    const listeners: Array<[string, () => void]> = []
    let running: Compiler | undefined

    try {
      const runPromise = runCli(['dev', '--profile'], {
        write: () => {},
        error: () => {},
        signals: {
          once: (name: string, fn: () => void) => {
            listeners.push([name, fn])
          },
        },
        onStart: (compiler) => {
          running = compiler
        },
      })

      await vi.waitFor(() => {
        expect(running).toBeDefined()
        expect(listeners.length).toBeGreaterThan(0)
      })

      listeners[0]![1]()

      await expect(runPromise).resolves.toBe(0)
      expect(running!.options.profile.enabled).toBe(true)
    } finally {
      process.chdir(previous)
      await running?.stop()
    }
  }, 30000)

  it('reports a missing config for dev', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-clidevempty-'))
    const errors: string[] = []

    const code = await runCli(['dev'], {
      cwd: () => dir!,
      write: () => {},
      error: (message) => errors.push(message),
      attachSignals: false,
    })

    expect(code).toBe(1)
    expect(errors.some((line) => line.includes('deltic init'))).toBe(true)
  })

  it('init falls back to process.cwd', async () => {
    const previous = process.cwd()
    const empty = await mkdtemp(path.join(tmpdir(), 'deltic-initcwd-'))

    process.chdir(empty)

    try {
      const code = await runCli(['init'], {
        write: () => {},
        error: () => {},
      })

      expect(code).toBe(0)
      expect(existsSync(path.join(empty, 'deltic.config.ts'))).toBe(true)
    } finally {
      process.chdir(previous)
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('reports Error throws with their message', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cliboom2-'))
    const errors: string[] = []

    const code = await runCli(['init'], {
      cwd: () => {
        throw new Error('cwd Error boom')
      },
      write: () => {},
      error: (message) => errors.push(message),
    })

    expect(code).toBe(1)
    expect(errors).toContain('cwd Error boom')
  })

  it('routes runCli() without deps through console sinks', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-clinodeps-'))
    const previous = process.cwd()
    process.chdir(dir!)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const code = await runCli(['build'])

      expect(code).toBe(1)
      expect(err).toHaveBeenCalled()
    } finally {
      process.chdir(previous)
      log.mockRestore()
      err.mockRestore()
    }
  })

  it('reports unexpected failures with a non-zero exit code', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cliboom-'))
    const errors: string[] = []

    const code = await runCli(['init'], {
      cwd: () => {
        throw 'cwd string boom'
      },
      write: () => {},
      error: (message) => errors.push(message),
    })

    expect(code).toBe(1)
    expect(errors).toContain('cwd string boom')
  })

  it('reports unknown commands with a non-zero exit code', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-cliunknown-'))
    const errors: string[] = []

    const code = await runCli(['definitely-not-a-command'], {
      cwd: () => dir!,
      write: () => {},
      error: (message) => errors.push(message),
    })

    expect(code).toBe(1)
    expect(errors.join('\n').length).toBeGreaterThan(0)
  })

  it('falls back to console sinks when write/error are omitted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      const code = await runCli(['--version'], { version: '0.0.0-sink' })

      expect(code).toBe(0)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('main() mirrors runCli through process.argv', async () => {
    const previousArgv = process.argv
    const previousExitCode = process.exitCode

    process.argv = ['node', 'deltic', '--version']

    try {
      await main()
      expect(process.exitCode).toBe(0)
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
    }
  })
})
