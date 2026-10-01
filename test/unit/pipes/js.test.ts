import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { jsPipe } from '../../../src/pipes/js.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'

function setup(contents: string, overrides: Parameters<typeof makeContext>[0] = {}) {
  const dependFn = vi.fn(
    (_file: unknown, _options?: unknown) => ({
      path: '',
      dependencies: [],
      requiredBy: [],
    }),
  )
  const context = makeContext({ ...overrides, depend: dependFn })
  const file = makeFile(path.resolve('/project/src/pages/home.js'), contents)
  file.context = context

  return { dependFn, context, file }
}

const relativeToHome = (target: string): string =>
  path
    .relative(
      path.dirname(path.resolve('/project/src/pages/home.js')),
      path.resolve(target),
    )
    .replace(/\\/g, '/')

describe('jsPipe', () => {
  it('applies alias, env and dependency collection in order', async () => {
    const { dependFn, context, file } = setup(
      "import x from '@/utils/a'\nconst api = process.env.API\n",
    )

    const { files, error } = await runStream(jsPipe(), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(files[0]!.contents!.toString()).toBe(
      `import x from '${relativeToHome('/project/src/utils/a')}'\n` +
        'const api = "https://api.example.com"\n',
    )
    expect(context.customDeps).toEqual([
      path.resolve('/project/src', '.env/API'),
    ])
    expect(dependFn).toHaveBeenCalledOnce()
    expect(dependFn.mock.calls[0]![0]).toBe(file)
  })

  it('honors explicit alias and env overrides', async () => {
    const { dependFn, file } = setup(
      "import x from 'ui/y'\nconst api = process.env.API\n",
      { alias: { '@': '/nope' }, env: { API: 'from-context' } },
    )

    const { files, error } = await runStream(
      jsPipe({ alias: { ui: '/project/src' }, env: { API: 'override' } }),
      [file],
    )

    expect(error).toBeNull()
    expect(files[0]!.contents!.toString()).toBe(
      `import x from '${relativeToHome('/project/src/y')}'\n` +
        'const api = "override"\n',
    )
    expect(dependFn).toHaveBeenCalledOnce()
  })

  it('supports custom matchers', async () => {
    const matcher = /url\(['"](.*?)['"]\)/g
    const { dependFn, file } = setup('x')

    await runStream(jsPipe({ matchers: [matcher] }), [file])

    expect(dependFn).toHaveBeenCalledOnce()
    expect(
      (dependFn.mock.calls[0]![1] as { matchers: RegExp[] }).matchers,
    ).toEqual([matcher])
  })

  it('defaults to CommonJS and ESM import matchers', async () => {
    const { dependFn, file } = setup('x')

    await runStream(jsPipe(), [file])

    expect(dependFn).toHaveBeenCalledOnce()
    const matchers = (dependFn.mock.calls[0]![1] as { matchers: RegExp[] })
      .matchers
    expect(matchers).toHaveLength(2)
  })
})
