import { mkdirSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { Compiler } from '../../src/compiler.js'
import { createTransform } from '../../src/index.js'
import { definePlugin } from '../../src/plugins/define-plugin.js'
import { createProject, type Project } from './helpers.js'
import type { PipeRef, SessionContext, UserConfig } from '../../src/types.js'

const FILES = {
  'a.js': "export const a = 'a'\n",
  'b.js': "export const b = 'b'\n",
  'c.js': "export const c = 'c'\n",
}

// Same behavior, different source text — the task checksum keys on the
// factory's source, so switching between the two invalidates the task.
function pipeV1() {
  return createTransform('probe', (file, next) => next(null, file))
}
function pipeV2() {
  return createTransform('probe', (file, next) => {
    next(null, file)
  })
}

const pipeTask = (use: PipeRef): Partial<UserConfig> => ({
  tasks: { js: { test: '**/*.js', use } },
})

async function runOnce(
  project: Project,
  overrides: Partial<UserConfig> = {},
): Promise<SessionContext> {
  const compiler = new Compiler(project.config(overrides))

  try {
    return await compiler.run()
  } finally {
    await compiler.stop()
  }
}

describe('compile cache', () => {
  it('invalidates the whole task when its pipe source changes, not just the first file', async () => {
    const project = await createProject(FILES)

    const first = await runOnce(project, pipeTask(pipeV1))
    expect(first.totalHit).toBe(0)

    const warm = await runOnce(project, pipeTask(pipeV1))
    expect(warm.totalHit).toBe(3)

    // The task checksum changed: every file of the task must recompile. With
    // the in-memory sum refreshed after the first file, the remaining files
    // would wrongly hit the cache.
    const changed = await runOnce(project, pipeTask(pipeV2))
    expect(changed.totalHit).toBe(0)

    // The flushed sum takes effect on the next run — no extra cycle.
    const settled = await runOnce(project, pipeTask(pipeV2))
    expect(settled.totalHit).toBe(3)
  }, 20000)

  it('recompiles everything when the output directory was deleted, even if a clean-hook plugin recreates it', async () => {
    const project = await createProject(FILES)
    await runOnce(project)

    // Derived-index plugins (a manifest, say) rewrite their artifact from the
    // 'clean' hook — which fires before the cache gate runs — and the mkdir
    // they issue resurrects the output directory.
    const resurrecting = definePlugin('resurrect-dist', ({ compiler, hooks }) => {
      hooks.on('clean', () => {
        mkdirSync(compiler.outputDir, { recursive: true })
      })
    })

    rmSync(project.distDir, { recursive: true, force: true })
    expect(project.has('a.js')).toBe(false)

    const session = await runOnce(project, { plugins: [resurrecting] })

    expect(session.totalHit).toBe(0)
    expect(project.has('a.js')).toBe(true)
    expect(project.has('b.js')).toBe(true)
    expect(project.has('c.js')).toBe(true)
  }, 20000)
})
