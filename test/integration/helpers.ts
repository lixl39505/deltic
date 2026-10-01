import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

import type { UserConfig } from '../../src/types.js'
import type { Logger } from '../../src/utils/logger.js'
import { preset } from '../../src/preset/index.js'

let roots: string[] = []

afterEach(async () => {
  const pending = roots

  roots = []

  for (const root of pending) {
    await rm(root, { recursive: true, force: true, retryDelay: 200, maxRetries: 5 })
  }
})

export function captureLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = []

  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  }
}

export interface Project {
  root: string
  srcDir: string
  distDir: string
  logger: Logger
  lines: string[]
  write(files: Record<string, string>): Promise<void>
  read(relPath: string): Promise<string>
  has(relPath: string): boolean
  config(overrides?: Partial<UserConfig>): UserConfig
}

export async function createProject(
  files: Record<string, string> = {},
  configOverrides: Partial<UserConfig> = {},
  /** Subdirectory appended to the tmp root — e.g. a glob-magic folder name. */
  rootSuffix = '',
): Promise<Project> {
  const parent = await mkdtemp(path.join(tmpdir(), 'deltic-it-'))
  const root = path.join(parent, rootSuffix)

  roots.push(parent)

  const srcDir = path.join(root, 'src')
  const distDir = path.join(root, 'dist')
  const { logger, lines } = captureLogger()

  const project: Project = {
    root,
    srcDir,
    distDir,
    logger,
    lines,
    async write(next) {
      for (const [rel, content] of Object.entries(next)) {
        const target = path.join(srcDir, rel)

        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
      }
    },
    async read(relPath) {
      const { readFile } = await import('node:fs/promises')

      return readFile(path.join(distDir, relPath), 'utf8')
    },
    has(relPath) {
      return existsSync(path.join(distDir, relPath))
    },
    config(overrides2 = {}) {
      return {
        baseDir: root,
        logger,
        progress: false,
        tasks: preset({ assets: false }),
        ...configOverrides,
        ...overrides2,
      }
    },
  }

  await project.write(files)

  return project
}
