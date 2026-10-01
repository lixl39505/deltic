import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CompileError } from '../../../src/errors.js'
import { createTransform, deriveFile, wrapPipeError } from '../../../src/pipes/stream.js'
import { makeFile, runStream } from '../../helpers/stream.js'

describe('createTransform', () => {
  it('passes null files through without invoking the body', async () => {
    let called = 0
    const stream = createTransform('test', () => {
      called += 1
    })

    const file = makeFile('/project/src/a.js', '')
    file.contents = null

    const { files, error } = await runStream(stream, [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(called).toBe(0)
  })

  it('rejects streaming files', async () => {
    const file = makeFile('/project/src/a.js', '')
    ;(file as unknown as { isStream(): boolean }).isStream = () => true

    const { files, error } = await runStream(
      createTransform('test', () => {}),
      [file],
    )

    expect(files).toHaveLength(0)
    expect(error).toBeInstanceOf(CompileError)
    expect((error as Error).message).toContain('streaming contents')
  })

  it('wraps thrown errors with the pipe name', async () => {
    const file = makeFile('/project/src/a.js', 'x')

    const { files, error } = await runStream(
      createTransform('test', () => {
        throw new Error('boom')
      }),
      [file],
    )

    expect(files).toHaveLength(0)
    expect((error as Error).message).toContain('[test] boom')
    expect((error as Error & { file?: string }).file).toBe(file.path)
  })

  it('lets the next callback carry errors', async () => {
    const { files, error } = await runStream(
      createTransform('test', (_file, next) => {
        next(new Error('next-error'))
      }),
      [makeFile('/project/src/a.js', 'x')],
    )

    expect(files).toHaveLength(0)
    expect((error as Error).message).toContain('next-error')
  })

  it('supports dropping files via next(null, null)', async () => {
    const { files } = await runStream(
      createTransform('test', (_file, next) => {
        next(null, null)
      }),
      [makeFile('/project/src/a.js', 'x')],
    )

    expect(files).toHaveLength(0)
  })
})

describe('wrapPipeError', () => {
  it('returns CompileError instances untouched', () => {
    const original = new CompileError('already wrapped')
    const file = makeFile('/project/src/a.js', '')

    expect(wrapPipeError('pipe', file, original)).toBe(original)
  })

  it('wraps non-error values', () => {
    const file = makeFile('/project/src/a.js', '')
    const error = wrapPipeError('pipe', file, 'text failure')

    expect(error.message).toContain('[pipe] text failure')
    expect(error.message).toContain(file.path)
    expect(error.cause).toBe('text failure')
    expect(error.file).toBe(file.path)
  })
})

describe('deriveFile', () => {
  it('inherits cwd/base and shares the parent context', () => {
    const base = path.resolve('/project/src')
    const parent = makeFile(path.join(base, 'a.vue'), 'parent', base)
    const context = { originalPath: parent.path }
    ;(parent as { context?: unknown }).context = context

    const derived = deriveFile(parent, {
      path: path.join(base, 'a', 'a.js'),
      contents: Buffer.from('derived'),
    })

    expect(derived.cwd).toBe(parent.cwd)
    expect(derived.base).toBe(base)
    expect(derived.path).toBe(path.join(base, 'a', 'a.js'))
    expect(derived.contents).toEqual(Buffer.from('derived'))
    expect((derived as { context?: unknown }).context).toBe(context)
  })

  it('leaves the context unset when the parent has none', () => {
    const parent = makeFile('/project/src/a.vue', 'parent')

    const derived = deriveFile(parent, {
      path: '/project/src/a/a.js',
      contents: Buffer.from('derived'),
    })

    expect((derived as { context?: unknown }).context).toBeUndefined()
  })
})
