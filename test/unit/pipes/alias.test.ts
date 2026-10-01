import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_ALIAS_STRATEGIES, aliasPipe } from '../../../src/pipes/alias.js'
import { makeContext, makeFile, runStream } from '../../helpers/stream.js'
import type { VinylType } from '../../helpers/stream.js'

const SRC = path.resolve('/project/src')

const fileAt = (segments: string[], contents: string): VinylType => {
  const file = makeFile(path.join(SRC, ...segments), contents)
  return file
}

const expectAlias = async (
  segments: string[],
  contents: string,
  alias: Record<string, string>,
  replacements: Array<{ request: string; target: string }>,
  options?: Parameters<typeof aliasPipe>[0],
) => {
  const file = fileAt(segments, contents)
  file.context = makeContext({ alias })

  const { files, error } = await runStream(aliasPipe(options), [file])

  expect(error).toBeNull()

  let expected = contents

  for (const { request, target } of replacements) {
    const rewritten = path.join(SRC, ...target.split('/'))

    let rel = path
      .relative(path.dirname(file.path), rewritten)
      .replace(/\\/g, '/')

    if (!rel.startsWith('.')) {
      rel = `./${rel}`
    }

    expected = expected.replace(request, () => rel)
  }

  expect(files[0]!.contents!.toString()).toBe(expected)
}

describe('aliasPipe', () => {
  it('rewrites ESM imports for js files', async () => {
    await expectAlias(
      ['pages', 'home.js'],
      "import x from '@/utils/a'\n",
      { '@': SRC },
      [{ request: '@/utils/a', target: 'utils/a' }],
    )
  })

  it('rewrites CommonJS requires', async () => {
    await expectAlias(
      ['pages', 'home.js'],
      "const x = require('@/utils/a')\n",
      { '@': SRC },
      [{ request: '@/utils/a', target: 'utils/a' }],
    )
  })

  it('marks same-directory results with an explicit ./ prefix', async () => {
    await expectAlias(
      ['js', 'entry.js'],
      "import { lib } from '@/js/lib'\n",
      { '@': SRC },
      [{ request: '@/js/lib', target: 'js/lib' }],
    )
  })

  it('leaves bare alias requests without a subpath untouched', async () => {
    const file = fileAt(['a.js'], "import '@'\n")
    file.context = makeContext({ alias: { '@': SRC } })

    const { files } = await runStream(aliasPipe({ alias: { '@': SRC } }), [file])

    expect(files[0]!.contents!.toString()).toBe("import '@'\n")
  })

  it('keeps unknown prefixes and non-alias requests', async () => {
    const file = fileAt(
      ['a.js'],
      "import x from 'other/y'\nimport y from 'react'\n",
    )
    file.context = makeContext({ alias: { '@': SRC } })

    const { files } = await runStream(aliasPipe({ alias: { '@': SRC } }), [file])

    expect(files[0]!.contents!.toString()).toBe(
      "import x from 'other/y'\nimport y from 'react'\n",
    )
  })

  it('inlines http aliases without path normalization', async () => {
    const file = fileAt(['a.js'], "import x from 'cdn/lib/a.js'\n")
    file.context = makeContext({ alias: { cdn: 'https://cdn.example.com/' } })

    const { files } = await runStream(
      aliasPipe({ alias: { cdn: 'https://cdn.example.com/' } }),
      [file],
    )

    expect(files[0]!.contents!.toString()).toBe(
      "import x from 'https://cdn.example.com/lib/a.js'\n",
    )
  })

  it('rewrites html attribute references', async () => {
    await expectAlias(
      ['pages', 'index.html'],
      '<img src="@/logo.png">',
      { '@': SRC },
      [{ request: '@/logo.png', target: 'logo.png' }],
    )
  })

  it('rewrites css url() and @import references', async () => {
    await expectAlias(
      ['pages', 'a.css'],
      "@import '@/vars.css';\n.a { background: url('@/img/x.png'); }\n",
      { '@': SRC },
      [
        { request: '@/vars.css', target: 'vars.css' },
        { request: '@/img/x.png', target: 'img/x.png' },
      ],
    )
  })

  it('skips extensions without a strategy', async () => {
    const file = fileAt(['a.json'], '{"a": "@/b"}')
    file.context = makeContext({ alias: { '@': SRC } })

    const { files } = await runStream(aliasPipe({ alias: { '@': SRC } }), [file])

    expect(files[0]!.contents!.toString()).toBe('{"a": "@/b"}')
  })

  it('supports custom strategies', async () => {
    await expectAlias(
      ['a.txt'],
      "import x from '@/y'\n",
      { '@': SRC },
      [{ request: '@/y', target: 'y' }],
      { strategies: { '.txt': 'js', '.js': 'none' } },
    )
  })

  it('falls back to the compiler alias map', async () => {
    await expectAlias(['a.js'], "import x from '@/y'\n", { '@': SRC }, [
      { request: '@/y', target: 'y' },
    ])
  })

  it('rebuilds the pattern when the alias map changes between files', async () => {
    const pipe = aliasPipe()

    const first = fileAt(['a.js'], "import x from '@/y'\n")
    first.context = makeContext({ alias: { '@': SRC } })

    const at = path.resolve(SRC, 'y')
    const second = fileAt(['a.js'], "import x from '~/y'\n")
    second.context = makeContext({ alias: { '~': SRC } })

    const { files, error } = await runStream(pipe, [first, second])

    expect(error).toBeNull()

    let rel = path.relative(path.dirname(first.path), at).replace(/\\/g, '/')

    if (!rel.startsWith('.')) {
      rel = `./${rel}`
    }

    const expected = `import x from '${rel}'\n`

    expect(files).toHaveLength(2)
    expect(files[0]!.contents!.toString()).toBe(expected)
    expect(files[1]!.contents!.toString()).toBe(expected)
  })

  it('escapes $ sequences in alias targets', async () => {
    const file = fileAt(['a.js'], "import x from '@/y'\n")
    file.context = makeContext({ alias: { '@': path.join(SRC, '$&src') } })

    const { files } = await runStream(
      aliasPipe({ alias: { '@': path.join(SRC, '$&src') } }),
      [file],
    )

    const out = files[0]!.contents!.toString()

    expect(out).toContain('$&src')
    expect(out).not.toContain("import x from '@/y'")
  })

  it('passes through when the alias map is empty', async () => {
    const file = fileAt(['a.js'], "import x from '@/y'\n")
    file.context = makeContext({ alias: {} })

    const { files, error } = await runStream(aliasPipe({ alias: {} }), [file])

    expect(error).toBeNull()
    expect(files).toHaveLength(1)
    expect(files[0]!.contents!.toString()).toBe("import x from '@/y'\n")
  })

  it('defaults cover the documented extension table', () => {
    expect(DEFAULT_ALIAS_STRATEGIES['.js']).toBe('js')
    expect(DEFAULT_ALIAS_STRATEGIES['.html']).toBe('html')
    expect(DEFAULT_ALIAS_STRATEGIES['.css']).toBe('css')
    expect(DEFAULT_ALIAS_STRATEGIES['.mjs']).toBe('js')
    expect(DEFAULT_ALIAS_STRATEGIES['.stylus']).toBe('css')
  })

  it('wraps transform errors as CompileError', async () => {
    const file = fileAt(['a.js'], 'content')
    file.context = makeContext({ withoutOptions: true })

    const { error } = await runStream(aliasPipe(), [file])

    expect(error).not.toBeNull()
    expect((error as Error).message).toContain('[alias]')
    expect((error as Error & { file?: string }).file).toBe(file.path)
  })
})
