import { describe, expect, it, vi } from 'vitest'

import { CompileError } from '../../../src/errors.js'
import { depAddPipe } from '../../../src/pipes/dep-add.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('depAddPipe', () => {
  it('appends literal paths', async () => {
    const addDep = vi.fn()
    const file = makeFile('/project/src/a.js', '')
    file.context = makeContext({ addDep })

    const { files, error } = await runStream(
      depAddPipe({ paths: '/project/src/dep.js' }),
      [file],
    )

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(addDep).toHaveBeenCalledOnce()
    expect(addDep.mock.calls[0]![0]).toBe(file)
    expect(addDep.mock.calls[0]![1]).toBe('/project/src/dep.js')
  })

  it('supports function paths receiving file and context', async () => {
    const addDep = vi.fn()
    const file = makeFile('/project/src/a.js', '')
    const context = makeContext({ addDep })
    file.context = context

    await runStream(
      depAddPipe({ paths: (f, ctx) => [f.path, ctx.sourceDir] }),
      [file],
    )

    expect(addDep.mock.calls[0]![0]).toBe(file)
    expect(addDep.mock.calls[0]![1]).toEqual([file.path, '/project/src'])
  })

  it('wraps capability errors as CompileError', async () => {
    const file = makeFile('/project/src/a.js', '')
    file.context = makeContext({
      addDep: () => {
        throw new Error('missing node')
      },
    })

    const { files, error } = await runStream(depAddPipe({ paths: ['x'] }), [file])

    expect(files).toHaveLength(0)
    expect(error).toBeInstanceOf(CompileError)
    expect((error as Error).message).toContain('[dep-add]')
  })
})
