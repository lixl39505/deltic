import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Compiler } from '../../src/compiler.js'
import { captureLogger, createProject, type Project } from './helpers.js'
import type { SessionContext, UserConfig } from '../../src/types.js'

const FILES = {
  'js/entry.js':
    "import { lib } from './lib'\nexport const api = process.env.API_NAME\n",
  'js/lib.js': "export const lib = 'v1'\n",
}

const CONFIG = {
  alias: { '@': './src' },
  env: { API_NAME: 'api' },
}

async function runOnce(
  project: Project,
  overrides: Partial<UserConfig> = {},
): Promise<SessionContext> {
  const compiler = new Compiler(project.config({ ...CONFIG, ...overrides }))

  try {
    return await compiler.run()
  } finally {
    await compiler.stop()
  }
}

describe('incrementCompile', () => {
  it('rebuilds targets plus compileAncestor upstream, bypassing the cache', async () => {
    const project = await createProject(FILES)
    await runOnce(project)

    await project.write({ 'js/lib.js': "export const lib = 'v2'\n" })

    const compiler = new Compiler(project.config(CONFIG))
    await compiler.ready

    const batches: SessionContext[] = []
    compiler.on('afterCompile', ({ session }) => {
      batches.push(session)
    })

    await compiler.incrementCompile([path.join(project.srcDir, 'js', 'lib.js')])

    expect(batches).toHaveLength(1)
    // incremental batches ignore the cache: both target and upstream rebuilt
    expect(batches[0]!.total).toBe(2)

    expect(await project.read(path.join('js', 'lib.js'))).toContain('v2')

    const cachedPass = await runOnce(project)

    // the incremental batch bypasses the cache entirely, so its rewritten file
    // carries a stale record — the pre-filter catches it; entry.js is genuinely
    // unchanged and is filtered out before the pipeline (total counts only
    // files that actually enter a pipeline now)
    expect(cachedPass.total).toBe(2)
    expect(cachedPass.totalHit).toBe(1)

    await compiler.stop()
  }, 20000)

  it('recompiles a single file when tracing is disabled', async () => {
    const project = await createProject(FILES)
    await runOnce(project)

    await project.write({ 'js/lib.js': "export const lib = 'v3'\n" })

    const compiler = new Compiler(project.config(CONFIG))
    await compiler.ready

    const batches: SessionContext[] = []
    compiler.on('afterCompile', ({ session }) => {
      batches.push(session)
    })

    await compiler.incrementCompile(
      [path.join(project.srcDir, 'js', 'lib.js')],
      false,
    )

    expect(batches[0]!.total).toBe(1)

    expect(await project.read(path.join('js', 'lib.js'))).toContain('v3')

    await compiler.stop()
  }, 20000)

  it('skips unknown file types with a warning', async () => {
    const project = await createProject(FILES)
    await runOnce(project)

    const { logger, lines } = captureLogger()
    const compiler = new Compiler(project.config({ ...CONFIG, logger }))
    await compiler.ready

    await compiler.incrementCompile([path.join(project.srcDir, 'README.mdx')])

    expect(lines.some((line) => line.includes('not supported'))).toBe(true)

    await compiler.stop()
  }, 20000)
})
