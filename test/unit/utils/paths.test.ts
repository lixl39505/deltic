import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  escapeGlobLiteral,
  joinGlob,
  stripBase,
  toGlobPath,
} from '../../../src/utils/paths.js'

const S = path.sep

describe('toGlobPath', () => {
  it('converts separators to slashes when sep is backslash', () => {
    expect(toGlobPath('a\\b\\c.js', '\\')).toBe('a/b/c.js')
  })

  it('keeps normalized separators when sep is a slash', () => {
    const input = path.normalize('a/b/c.js')

    expect(toGlobPath(input, '/')).toBe(input)
  })
})

describe('escapeGlobLiteral', () => {
  it('escapes every glob-magic character in a literal path', () => {
    // outputs are glob patterns: always forward slashes, class-form escapes
    expect(
      escapeGlobLiteral(['ci', 'job(3) [x]', 'a+b!c{i}.js'].join(S)),
    ).toBe('ci/job[(]3[)] [[]x[]]/a[+]b[!]c[{]i[}].js')
  })

  it('leaves plain paths untouched', () => {
    expect(escapeGlobLiteral(['plain', 'src'].join(S))).toBe('plain/src')
  })

  it('always produces forward slashes for glob embedding', () => {
    expect(escapeGlobLiteral('a\\b(1)\\c', '\\')).toBe('a/b[(]1[)]/c')
  })
})

describe('joinGlob', () => {
  it('escapes the literal base and keeps the authored pattern', () => {
    expect(joinGlob(['ci', 'job(3)'].join(S), '**/*.js')).toBe(
      'ci/job[(]3[)]/**/*.js',
    )
  })

  it('normalizes backslashes inside the pattern part', () => {
    expect(joinGlob('base', 'src\\**\\*.ts', '/')).toBe('base/src/**/*.ts')
  })
})

describe('stripBase', () => {
  it('strips the base prefix keeping the leading separator', () => {
    const base = ['project', 'src'].join(S)

    expect(stripBase([base, 'js', 'a.js'].join(S), base)).toBe('/js/a.js')
  })

  it('compares case-insensitively but preserves the original casing', () => {
    const base = ['project', 'src'].join(S)

    expect(stripBase(['Project', 'SRC', 'js', 'a.js'].join(S), base)).toBe(
      '/js/a.js',
    )
  })

  it('returns the original path when the base is not a prefix', () => {
    expect(stripBase(['elsewhere', 'a.js'].join(S), ['project'].join(S))).toBe(
      ['elsewhere', 'a.js'].join(S),
    )
  })

  it('returns the root separator for the base itself', () => {
    const base = ['project', 'src'].join(S)

    expect(stripBase(base, base)).toBe('/')
  })

  it('ignores trailing separators on the base', () => {
    const base = ['project', 'src'].join(S)

    expect(stripBase([base, 'a.js'].join(S), base + S)).toBe('/a.js')
  })

  it('works with platform-resolved absolute paths', () => {
    const base = path.resolve('/project/src')
    const filePath = path.join(base, 'js', 'a.js')

    expect(stripBase(filePath, base)).toBe('/js/a.js')
  })
})
