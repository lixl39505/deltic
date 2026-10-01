import { describe, expect, it, vi } from 'vitest'

import { json5Pipe, jsonPipe } from '../../../src/pipes/json.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

function setup(contents: string) {
  const dependFn = vi.fn(
    (_file: unknown, _options?: unknown) => ({
      path: '',
      dependencies: [],
      requiredBy: [],
    }),
  )
  const context = makeContext({ depend: dependFn })
  const file = makeFile('/project/src/a.json', contents)
  file.context = context

  return { dependFn, file }
}

describe('jsonPipe', () => {
  it('applies env but leaves JSON structure untouched by default', async () => {
    const { dependFn, file } = setup('process.env.API')

    const { files, error } = await runStream(jsonPipe(), [file])

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe('"https://api.example.com"')
    expect(dependFn).toHaveBeenCalledOnce()
    expect(
      (dependFn.mock.calls[0]![1] as { matchers: unknown[] }).matchers,
    ).toEqual([])
  })

  it('normalizes json5 content when requested', async () => {
    const file = makeFile('/project/src/a.json5', '{a: 1}')
    file.context = makeContext()

    const { files, error } = await runStream(jsonPipe({ json5: true }), [file])

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe('{\n    "a": 1\n}')
  })

  it('json5Pipe delegates with json5 enabled', async () => {
    const file = makeFile('/project/src/a.json5', '{a: 1}')
    file.context = makeContext()

    const { files, error } = await runStream(json5Pipe(), [file])

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe('{\n    "a": 1\n}')
  })

  it('supports custom matchers', async () => {
    const matcher = /"(.*?)"/g
    const { dependFn, file } = setup('{"dep": "./b.js"}')

    await runStream(jsonPipe({ matchers: [matcher] }), [file])

    expect(
      (dependFn.mock.calls[0]![1] as { matchers: RegExp[] }).matchers,
    ).toEqual([matcher])
  })

  it('applies explicit env overrides', async () => {
    const file = makeFile('/project/src/a.json', 'process.env.API')
    file.context = makeContext()

    const { files } = await runStream(jsonPipe({ env: { API: 'x' } }), [file])

    expect(files[0]!.contents!.toString()).toBe('"x"')
  })
})
