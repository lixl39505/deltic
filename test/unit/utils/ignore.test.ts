import { describe, expect, it } from 'vitest'

import { createIgnoreMatcher } from '../../../src/utils/ignore.js'

describe('createIgnoreMatcher', () => {
  it('matches tree globs against forward-slash absolute paths', () => {
    const matcher = createIgnoreMatcher(['**/node_modules/**'])

    expect(matcher('C:/proj/src/node_modules/pkg/a.js')).toBe(true)
    expect(matcher('C:/proj/src/js/a.js')).toBe(false)
  })

  it('matches windows backslash paths', () => {
    const matcher = createIgnoreMatcher(['**/tmp/**'])

    expect(matcher('C:\\proj\\src\\tmp\\a.js')).toBe(true)
  })

  it('prunes a directory whose children would match', () => {
    const matcher = createIgnoreMatcher(['**/tmp/**'])

    expect(matcher('C:/proj/src/tmp')).toBe(true)
  })

  it('keeps files outside the ignored subtree untouched', () => {
    const matcher = createIgnoreMatcher(['**/assets/**'])

    expect(matcher('C:/proj/src/assets/a.js')).toBe(true)
    expect(matcher('C:/proj/src/asset/a.js')).toBe(false)
  })

  it('supports brace expansion', () => {
    const matcher = createIgnoreMatcher(['**/*.{jpg,png}'])

    expect(matcher('C:/proj/src/a.png')).toBe(true)
    expect(matcher('C:/proj/src/a.gif')).toBe(false)
  })

  it('matches absolute directory globs', () => {
    const matcher = createIgnoreMatcher(['C:/proj/dist/**'])

    expect(matcher('C:/proj/dist/a.js')).toBe(true)
    expect(matcher('C:/proj/src/a.js')).toBe(false)
  })

  it('matches exact directory names', () => {
    const matcher = createIgnoreMatcher(['**/profile'])

    expect(matcher('C:/proj/src/profile')).toBe(true)
    expect(matcher('C:/proj/src/profilex')).toBe(false)
  })

  it('applies regexp patterns', () => {
    const matcher = createIgnoreMatcher([/(^|[/\\])\.env(\..+)?$/])

    expect(matcher('C:/proj/src/.env')).toBe(true)
    expect(matcher('C:/proj/src/.env.local')).toBe(true)
    expect(matcher('C:/proj/src/env.js')).toBe(false)
  })

  it('returns false for everything without patterns', () => {
    const matcher = createIgnoreMatcher([])

    expect(matcher('C:/proj/src/a.js')).toBe(false)
  })

  it('matches dotfiles with dot enabled', () => {
    const matcher = createIgnoreMatcher(['**/.secret/**'])

    expect(matcher('C:/proj/src/.secret/a.js')).toBe(true)
  })
})
