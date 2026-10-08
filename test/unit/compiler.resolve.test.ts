import { describe, expect, it } from 'vitest'
import path from 'node:path'

import { Compiler } from '../../src/compiler.js'
import { cleanPlugin } from '../../src/plugins/clean.js'
import { compileCachePlugin } from '../../src/plugins/compile-cache.js'
import { definePlugin } from '../../src/plugins/define-plugin.js'
import { ConfigError } from '../../src/errors.js'
import { createProject } from '../integration/helpers.js'

// The builtin plugins are always installed, so opting out of one means
// replacing it by name with a no-op plugin.
const withoutDepGraph = definePlugin('dep-graph', () => {})

describe('Compiler.resolve', () => {
  it('resolves root-absolute requests against the source dir', async () => {
    const project = await createProject()
    const compiler = new Compiler(project.config({ tasks: {} }))

    await compiler.ready

    expect(compiler.resolve('/lib/a.js')).toBe(
      path.join(project.srcDir, 'lib/a.js'),
    )

    await compiler.stop()
  })

  it('resolves bare requests like node modules against the source dir', async () => {
    const project = await createProject()
    const compiler = new Compiler(project.config({ tasks: {} }))

    await compiler.ready

    expect(compiler.resolve('pkg/a.js')).toBe(
      path.resolve(project.srcDir, 'pkg/a.js'),
    )
    expect(compiler.resolve('./b.js', path.join(project.srcDir, 'a.js'))).toBe(
      path.resolve(project.srcDir, 'b.js'),
    )
    expect(compiler.resolve('../c.js', path.join(project.srcDir, 'x/a.js'))).toBe(
      path.resolve(project.srcDir, 'c.js'),
    )

    await compiler.stop()
  })

  it('manages the instance pipe registry', async () => {
    const project = await createProject()
    const compiler = new Compiler(project.config({ tasks: {} }))

    await compiler.ready

    const factory = () => ({}) as never

    compiler.setPipe('mine', factory)
    expect(compiler.getPipe('mine')).toBe(factory)

    compiler.removePipe('mine')
    expect(compiler.getPipe('mine')).toBeUndefined()

    await compiler.stop()
  })

  it('rejects pipes that do not return streams', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: {
            test: '**/*.js',
            use: [(() => ({ not: 'a stream' })) as never],
            output: false,
          },
        },
      }),
    )

    await expect(compiler.run()).rejects.toBeInstanceOf(ConfigError)

    await compiler.stop()
  })

  it('tolerates missing dep-graph on upstream compensation and tracing', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const config = project.config({
      plugins: [compileCachePlugin(), cleanPlugin(), withoutDepGraph],
      tasks: { js: { test: '**/*.js', use: ['pass-through'] } },
    })

    const first = new Compiler(config)
    const firstSession = await first.run()
    expect(firstSession.totalHit).toBe(0)
    await first.stop()

    const second = new Compiler(config)
    await second.ready

    // no dep-graph capability: upstream compensation and tracing are no-ops
    await second.incrementCompile([path.join(project.srcDir, 'js', 'a.js')])

    await second.stop()
  }, 20000)

  it('runs without any tasks', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(project.config({ tasks: {} }))

    await compiler.ready

    const session = await compiler.run()

    expect(session.total).toBe(0)

    await compiler.stop()
  })

  it('renders progress when enabled', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: { js: { test: '**/*.js', use: ['pass-through'] } },
        progress: true,
      }),
    )

    await compiler.ready
    await compiler.run()
    await compiler.stop()
  })

  it('skips upstream compensation without dep-graph on cached runs', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const config = project.config({
      plugins: [compileCachePlugin(), cleanPlugin(), withoutDepGraph],
      tasks: { js: { test: '**/*.js', use: ['pass-through'] } },
    })

    const first = new Compiler(config)
    await first.run()
    await first.stop()

    const second = new Compiler(config)
    const cached = await second.run()

    expect(cached.totalHit).toBe(cached.total)

    await second.stop()
  })
})
