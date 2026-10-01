import { describe, expect, it } from 'vitest'

import { CompileError } from '../../../src/errors.js'
import { oncePipe } from '../../../src/pipes/once.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('oncePipe', () => {
  it('passes changed files through', async () => {
    const context = makeContext({
      checkFileChanged: () => ({ changed: true, checksum: 'new' }),
    })
    const file = makeFile('/project/src/a.js', 'content')
    file.context = context

    const { files, error } = await runStream(oncePipe(), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(context.checkFileChanged).toHaveBeenCalledWith(file, {
      namespace: undefined,
      algorithm: undefined,
    })
  })

  it('drops unchanged files and reports the hit', async () => {
    const hits: unknown[] = []
    const context = makeContext({
      checkFileChanged: () => ({ changed: false, checksum: 'same' }),
    })
    const file = makeFile('/project/src/a.js', 'content')
    file.context = context

    const { files, error } = await runStream(
      oncePipe({ namespace: 'ns', hit: (f, result) => hits.push([f.path, result]) }),
      [file],
    )

    expect(error).toBeNull()
    expect(files).toHaveLength(0)
    expect(hits).toEqual([[file.path, { changed: false, checksum: 'same' }]])
  })

  it('forwards namespace functions and algorithms', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', '')
    file.context = context

    await runStream(
      oncePipe({
        namespace: (f) => f.path,
        algorithm: 'md5',
      }),
      [file],
    )

    expect(context.checkFileChanged).toHaveBeenCalledWith(file, {
      namespace: expect.any(Function),
      algorithm: 'md5',
    })
  })

  it('wraps capability errors as CompileError', async () => {
    const context = makeContext({
      checkFileChanged: () => {
        throw new Error('no cache')
      },
    })
    const file = makeFile('/project/src/a.js', '')
    file.context = context

    const { files, error } = await runStream(oncePipe(), [file])

    expect(files).toHaveLength(0)
    expect(error).toBeInstanceOf(CompileError)
    expect((error as Error).message).toContain('[once]')
  })
})
