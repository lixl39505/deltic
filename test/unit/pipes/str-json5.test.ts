import { describe, expect, it } from 'vitest'

import { strJson5Pipe } from '../../../src/pipes/str-json5.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('strJson5Pipe', () => {
  it('normalizes json5 to four-space JSON', async () => {
    const file = makeFile('/project/src/a.json', '{a: 1, /* c */ b: "x"}')
    file.context = makeContext()

    const { files, error } = await runStream(strJson5Pipe(), [file])

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe(
      '{\n    "a": 1,\n    "b": "x"\n}',
    )
  })

  it('supports a custom indent', async () => {
    const file = makeFile('/project/src/a.json', '{a: 1}')
    file.context = makeContext()

    const { files } = await runStream(strJson5Pipe({ space: 2 }), [file])

    expect(files[0]!.contents!.toString()).toBe('{\n  "a": 1\n}')
  })

  it('wraps parse errors as CompileError', async () => {
    const file = makeFile('/project/src/a.json', '{a: ')
    file.context = makeContext()

    const { files, error } = await runStream(strJson5Pipe(), [file])

    expect(files).toHaveLength(0)
    expect(error).not.toBeNull()
    expect((error as Error).message).toContain('[str-json5]')
  })

  it('passes null files through', async () => {
    const file = makeFile('/project/src/a.json', '')
    file.contents = null
    file.context = makeContext()

    const { files, error } = await runStream(strJson5Pipe(), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
  })
})
