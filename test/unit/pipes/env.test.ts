import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { envPipe } from '../../../src/pipes/env.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

describe('envPipe', () => {
  it('replaces defined values with JSON literals and records pseudo deps', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', 'const api = process.env.API\n')
    file.context = context

    const { files, error } = await runStream(envPipe(), [file])

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe(
      'const api = "https://api.example.com"\n',
    )
    expect(context.customDeps).toEqual([
      path.resolve('/project/src', '.env/API'),
    ])
  })

  it('falls back to the compiler env when not configured', async () => {
    const file = makeFile('/project/src/a.js', 'process.env.API')
    file.context = makeContext({ env: { API: 'x' } })

    const { files } = await runStream(envPipe(), [file])

    expect(files[0]!.contents!.toString()).toBe('"x"')
  })

  it('explicit env wins over the compiler env', async () => {
    const file = makeFile('/project/src/a.js', 'process.env.API')
    file.context = makeContext({ env: { API: 'from-context' } })

    const { files } = await runStream(envPipe({ env: { API: 'explicit' } }), [file])

    expect(files[0]!.contents!.toString()).toBe('"explicit"')
  })

  it('serializes numbers and booleans', async () => {
    const file = makeFile('/project/src/a.js', 'process.env.N + process.env.B')
    file.context = makeContext({ env: { N: '42', B: 'true' } })

    const { files } = await runStream(
      envPipe({ env: { N: '42', B: 'true' } }),
      [file],
    )

    expect(files[0]!.contents!.toString()).toBe('"42" + "true"')
  })

  it('replaces undefined variables with the literal undefined by default', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', 'process.env.MISSING')
    file.context = context

    const { files } = await runStream(envPipe(), [file])

    expect(files[0]!.contents!.toString()).toBe('undefined')
    expect(context.customDeps).toEqual([
      path.resolve('/project/src', '.env/MISSING'),
    ])
  })

  it('supports the null strategy', async () => {
    const file = makeFile('/project/src/a.js', 'process.env.MISSING')
    file.context = makeContext()

    const { files } = await runStream(envPipe({ missing: 'null' }), [file])

    expect(files[0]!.contents!.toString()).toBe('null')
  })

  it('keep leaves unknown variables and skips the pseudo dep', async () => {
    const context = makeContext()
    const file = makeFile('/project/src/a.js', 'process.env.MISSING')
    file.context = context

    const { files } = await runStream(envPipe({ missing: 'keep' }), [file])

    expect(files[0]!.contents!.toString()).toBe('process.env.MISSING')
    expect(context.customDeps).toEqual([])
  })

  it('supports custom patterns', async () => {
    const file = makeFile('/project/src/a.js', 'v=%API%')
    file.context = makeContext()

    const { files } = await runStream(
      envPipe({ pattern: /%([_a-zA-Z][_a-zA-Z0-9]*)%/g, env: { API: 'x' } }),
      [file],
    )

    expect(files[0]!.contents!.toString()).toBe('v="x"')
  })

  it('wraps context errors as CompileError', async () => {
    const file = makeFile('/project/src/a.js', 'process.env.API')
    file.context = makeContext({ withoutOptions: true })

    const { error } = await runStream(envPipe(), [file])

    expect(error).not.toBeNull()
    expect((error as Error).message).toContain('[env]')
  })

  it('passes null files through', async () => {
    const file = makeFile('/project/src/a.js', '')
    file.contents = null
    file.context = makeContext()

    const { files, error } = await runStream(envPipe(), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
  })
})
