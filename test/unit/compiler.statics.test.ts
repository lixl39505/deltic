import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Transform } from 'streamx'

import { Compiler, instrument } from '../../src/compiler.js'
import { dispatchGulpError } from '../../src/core/vfs.js'
import { watchSource } from '../../src/core/watcher.js'
import { definePlugin } from '../../src/plugins/define-plugin.js'
import { createProject } from '../integration/helpers.js'

describe('Compiler static registry', () => {
  it('setPipe/getPipe/removePipe manage the global default table', () => {
    const factory = () => new Transform()

    Compiler.setPipe('global-test', factory)
    expect(Compiler.getPipe('global-test')).toBe(factory)

    Compiler.removePipe('global-test')
    expect(Compiler.getPipe('global-test')).toBeUndefined()
    expect(Compiler.removePipe('global-test')).toBeUndefined()
  })

  it('use() installs plugins for instances created afterwards', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const setup = vi.fn()
    Compiler.use(definePlugin('static-spy', setup))

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
      }),
    )

    await compiler.ready

    expect(setup).toHaveBeenCalledOnce()
    expect(
      compiler.options.plugins.map((plugin) => plugin.name),
    ).toContain('static-spy')

    await compiler.stop()
  })

  it('exposes registerPipe through the plugin api', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
        plugins: [
          definePlugin('pipe-registrar', (api) => {
            api.registerPipe('registered', () => new Transform())
          }),
        ],
      }),
    )

    await compiler.ready
    expect(compiler.getPipe('registered')).toBeDefined()

    await compiler.stop()
  })

  it('routes watcher errors to the logger', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
      }),
    )

    await compiler.ready

    const watcher = watchSource(compiler)
    watcher.emit('error', new Error('watch boom'))
    await watcher.close()

    expect(project.lines).toContain('Error: watch boom')

    await compiler.stop()
  })

  it('accepts empty context extensions from plugins', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    let called = false
    const compiler = new Compiler(
      project.config({
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
        plugins: [
          definePlugin('empty-ext', (api) => {
            called = true
            api.extendContext({})
          }),
        ],
      }),
    )

    await compiler.ready
    expect(called).toBe(true)

    await compiler.stop()
  })

  it('propagates finish-step failures through the task callback', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
        plugins: [
          definePlugin('throwing-reverse', (api) => {
            api.extendContext({
              capabilities: {
                reverseDep: () => {
                  throw new Error('graph exploded')
                },
              },
            })
          }),
        ],
      }),
    )

    await compiler.ready

    await expect(compiler.run()).rejects.toThrowError('graph exploded')

    await compiler.stop()
  })

  it('survives taskError hook failures and still rejects with the original', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: {
            test: '**/*.js',
            use: [['boom', {}]],
            output: false,
          },
        },
        pipes: {
          boom: () =>
            new Transform({
              transform: (
                chunk: unknown,
                cb: (err: Error | null, data?: unknown) => void,
              ) => cb(new Error('pipe boom')),
            }),
        },
      }),
    )

    await compiler.ready
    compiler.on('taskError', () => Promise.reject(new Error('hook boom')))

    await expect(compiler.run()).rejects.toThrowError('pipe boom')

    await compiler.stop()
  })

  it('wraps the stage transform and reports timings', async () => {
    const measured = vi.fn()
    const stage = new Transform({
      transform: (chunk: unknown, cb: (err: Error | null, data?: unknown) => void) => {
        cb(null, chunk)
      },
    })
    const original = stage._transform

    const wrapped = instrument(stage, measured)

    expect(wrapped).toBe(stage)
    expect(stage._transform).not.toBe(original)
    stage.on('data', () => {})

    stage.write('chunk')
    stage.end(() => {})

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(measured).toHaveBeenCalled()
  })

  it('forwards gulp-level errors through the logger', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: { js: { test: '**/*.no-match', use: ['pass-through'], cache: false } },
      }),
    )

    await compiler.ready

    dispatchGulpError(new Error('gulp boom'))
    dispatchGulpError('gulp string boom')

    expect(project.lines).toContain('gulp boom')
    expect(project.lines).toContain('gulp string boom')

    await compiler.stop()
  })

  it('runs an empty task set without touching gulp', async () => {
    const project = await createProject({ 'js/keep.txt': '' })

    const compiler = new Compiler(
      project.config({ tasks: { js: { test: '**/*.no-match', use: ['pass-through'], cache: false } } }),
    )

    await compiler.ready

    const session = await compiler.run()

    expect(session.total).toBe(0)

    await compiler.stop()
  })

  it('supports string paths, falsy save keys, factory plugins and string increments', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const pluginObject = {
      name: 'factory-installed',
      setup: () => {},
    }

    // factory form of Compiler.use
    Compiler.use(() => pluginObject)

    const compiler = new Compiler(
      project.config({
        plugins: [() => pluginObject],
        tasks: {
          js: { test: '**/*.js', use: ['pass-through'], cache: false },
        },
      }),
    )

    await compiler.ready

    expect(compiler.options.plugins).toContain(pluginObject)

    compiler.save('', { ignored: true })

    await compiler.incrementCompile(path.join(project.srcDir, 'js', 'a.js'))
    await compiler.stop()
  }, 20000)

  it('progress sink tolerates chunks without a path', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: {
            test: '**/*.js',
            use: [
              () =>
                    new Transform({
                      transform: (
                        chunk: unknown,
                        cb: (err: Error | null, data?: unknown) => void,
                      ) => {
                        // simulate directory / pathless vinyl entries
                        cb(null, {})
                      },
                    }),
            ],
            output: false,
          },
        },
      }),
    )

    const session = await compiler.run()

    expect(session.total).toBe(1)

    await compiler.stop()
  }, 20000)

  it('accepts subclass-style pipes without an own _transform', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    class SubPipe extends Transform {
      override _transform(chunk: unknown, cb: (err: Error | null, data?: unknown) => void) {
        cb(null, chunk)
      }
    }

    const compiler = new Compiler(
      project.config({
        tasks: {
          js: {
            test: '**/*.js',
            use: [() => new SubPipe()],
            output: false,
          },
        },
      }),
    )

    const session = await compiler.run()

    expect(session.total).toBe(1)

    await compiler.stop()
  })
  it('skips pre-filtering when a plugin fakes the compile-cache name', async () => {
    const project = await createProject({
      'js/a.js': 'export const a = 1\n',
    })

    const compiler = new Compiler(
      project.config({
        tasks: { js: { test: '**/*.js', use: ['pass-through'], cache: true } },
        plugins: [{ name: 'compile-cache', setup: () => {} } as never],
      }),
    )

    await compiler.ready

    const session = await compiler.run()

    expect(session.total).toBe(1)
    expect(session.totalCache).toBe(0)

    await compiler.stop()
  }, 20000)
})
