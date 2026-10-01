import { describe, expect, it } from 'vitest'

import { passThroughPipe } from '../../../src/pipes/pass-through.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('passThroughPipe', () => {
  it('emits every chunk unchanged', async () => {
    const a = makeFile('/project/src/a.js', 'a')
    a.context = makeContext()
    const junk = { not: 'a-file' }

    const { files, error } = await runStream(passThroughPipe(), [a, junk])

    expect(error).toBeNull()
    expect(files).toEqual([a, junk])
  })
})
