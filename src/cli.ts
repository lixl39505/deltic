#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

import { Command, CommanderError } from 'commander'

import { Compiler } from './compiler.js'
import { acquireInstanceLock } from './core/instance-lock.js'
import { loadConfig } from './config/load-config.js'
import type { UserConfig } from './types.js'

const require = createRequire(import.meta.url)
const pkgInfo = require('../package.json') as { version: string }

const INIT_TEMPLATE = `import { defineConfig, preset } from 'deltic'

export default defineConfig({
  alias: {
    '@': './src',
  },

  // env: { API_URL: 'https://api.example.com' },
  // loadEnv: false,  // .env / .env.[mode] files load by default — uncomment to skip
  // profile: true,   // report the slowest pipes and files after each compile

  tasks: preset(),
})
`

export interface CliDeps {
  cwd?: () => string
  write?: (message: string) => void
  error?: (message: string) => void
  /** Set to false in tests to skip signal wiring entirely. */
  attachSignals?: boolean
  /** Signal source; main() passes `process`. */
  signals?: { once(name: string, fn: () => void): unknown }
  /** Called with the running compiler in dev mode (used by tests). */
  onStart?: (compiler: Compiler) => void
  version?: string
}

interface CommonOptions {
  config: string
  mode?: string
  profile?: boolean
  cache?: boolean
}

async function start(
  command: 'dev' | 'build',
  options: CommonOptions,
  deps: Required<Pick<CliDeps, 'write' | 'error'>> & CliDeps,
): Promise<number> {
  const baseDir = deps.cwd?.() ?? process.cwd()
  const loaded = loadConfig(baseDir, options.config)

  if (loaded === undefined) {
    deps.error(
      `no config file found in ${baseDir} — run "deltic init" to create one`,
    )
    return 1
  }

  const userConfig: UserConfig = { ...loaded.config }

  // config files rarely declare baseDir; anchor it to where the CLI looked
  userConfig.baseDir ??= baseDir

  if (options.mode !== undefined) {
    userConfig.mode = options.mode
  }

  if (options.profile === true) {
    userConfig.profile = true
  }

  if (options.cache === false) {
    userConfig.tasks = Object.fromEntries(
      Object.entries(loaded.config.tasks).map(([name, task]) => [
        name,
        { ...task, cache: false },
      ]),
    )
  }

  // Same default resolveOptions applies — the lock has to be claimed before
  // the compiler opens the SQLite store, so it cannot read it from there.
  const cacheDir = path.resolve(baseDir, userConfig.cacheDir ?? '.deltic')

  // One dev instance per project: a second watcher would double every event
  // and share the same state database.
  const lock =
    command === 'dev'
      ? await acquireInstanceLock(cacheDir, {
          cwd: baseDir,
          version: deps.version ?? pkgInfo.version,
        })
      : undefined

  try {
    const compiler = new Compiler(userConfig)

    if (command === 'dev') {
      await compiler.watch()

      deps.onStart?.(compiler)

      if (deps.attachSignals !== false) {
        // main() always provides process; tests inject fakes
        const signals = deps.signals!
        let stopping = false

        await new Promise<void>((resolve) => {
          const shutdown = (): void => {
            if (stopping) {
              return
            }

            stopping = true
            void compiler.stop().then(resolve)
          }

          signals.once('SIGINT', shutdown)
          signals.once('SIGTERM', shutdown)
        })
      }

      return 0
    }

    try {
      await compiler.run()
      return 0
    } finally {
      await compiler.stop()
    }
  } finally {
    await lock?.release()
  }
}

async function runInit(deps: Required<Pick<CliDeps, 'write' | 'error'>> & CliDeps): Promise<number> {
  const baseDir = deps.cwd?.() ?? process.cwd()
  const target = path.join(baseDir, 'deltic.config.ts')

  if (existsSync(target)) {
    deps.error(`${target} already exists`)
    return 1
  }

  await writeFile(target, INIT_TEMPLATE)
  deps.write(`created ${target}`)
  deps.write('next: pnpm add -D deltic && deltic build')

  return 0
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.write ?? ((message: string) => console.log(message))
  const error = deps.error ?? ((message: string) => console.error(message))
  const io = { write, error }

  const program = new Command()

  program
    .name('deltic')
    .version(deps.version ?? pkgInfo.version)
    .showHelpAfterError('(run "deltic --help" for usage)')
    .configureOutput({
      writeOut: (chunk) => write(chunk.trimEnd()),
      writeErr: (chunk) => error(chunk.trimEnd()),
    })
    .exitOverride()

  const addCommon = (command: Command): Command =>
    command
      .option('-c, --config <file>', 'config file name', 'deltic.config.ts')
      .option('-m, --mode <mode>', 'build mode')
      .option('--profile', 'report the slowest pipes and files')

  let exitCode = 0

  addCommon(
    program
      .command('dev', { isDefault: true })
      .description('compile once, then watch the source tree (default)'),
  )
    .action(async (options: CommonOptions) => {
      exitCode = await start('dev', options, { ...io, ...deps })
    })

  addCommon(program.command('build').description('compile once and exit'))
    .option('--no-cache', 'disable the compile cache for this run')
    .action(async (options: CommonOptions & { cache: boolean }) => {
      exitCode = await start('build', options, { ...io, ...deps })
    })

  program
    .command('init')
    .description('create a deltic.config.ts template in the current directory')
    .action(async () => {
      exitCode = await runInit({ ...io, ...deps })
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version exits carry exitCode 0; usage errors carry 1 and the
      // message was already routed through writeErr
      return err.exitCode
    }

    error(err instanceof Error ? err.message : String(err))
    return 1
  }

  return exitCode
}

export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2), { signals: process })
}
