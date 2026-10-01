import { describe, expect, it } from 'vitest'

import { CompileError } from '../../../src/errors.js'
import { dependPipe } from '../../../src/pipes/depend.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('dependPipe', () => {
  it('delegates to the dep-graph capability', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', 'content')
    file.context = context

    const { files, error } = await runStream(dependPipe({ matchers: [/a/g] }), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(context.depend).toHaveBeenCalledWith(file, { matchers: [/a/g] })
  })

  it('defaults to no matchers', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', 'content')
    file.context = context

    await runStream(dependPipe(), [file])

    expect(context.depend).toHaveBeenCalledWith(file, { matchers: undefined })
  })

  it('removes the graph node when collection fails', async () => {
    const context = makeContext({ depend: () => { throw new Error('bad regex') } })
    const file = makeFile('/project/src/a.js', 'content')
    file.context = context

    const { files, error } = await runStream(dependPipe(), [file])

    expect(files).toHaveLength(0)
    expect(context.removeGraphNodes).toHaveBeenCalledWith(file.path)
    expect(error).toBeInstanceOf(CompileError)
    expect((error as Error).message).toContain('[depend]')
  })
})
