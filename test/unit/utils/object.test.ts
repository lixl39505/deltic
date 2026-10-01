import { describe, expect, it } from 'vitest'

import { isPojo, objectMerge, typeOf } from '../../../src/utils/object.js'

describe('typeOf', () => {
  it('returns "null" / "undefined" for nullish values', () => {
    expect(typeOf(null)).toBe('null')
    expect(typeOf(undefined)).toBe('undefined')
  })

  it('returns the lowercase internal class name', () => {
    expect(typeOf({})).toBe('object')
    expect(typeOf([])).toBe('array')
    expect(typeOf(1)).toBe('number')
    expect(typeOf('a')).toBe('string')
    expect(typeOf(true)).toBe('boolean')
    expect(typeOf(() => {})).toBe('function')
  })
})

describe('isPojo', () => {
  it('accepts plain objects', () => {
    expect(isPojo({})).toBe(true)
    expect(isPojo(Object.create(Object.prototype))).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isPojo(null)).toBe(false)
    expect(isPojo(undefined)).toBe(false)
    expect(isPojo(1)).toBe(false)
    expect(isPojo(() => {})).toBe(false)
    expect(isPojo([])).toBe(false)
    expect(isPojo(new Date())).toBe(false)
    expect(isPojo(Object.create(null))).toBe(false)
  })
})

describe('objectMerge', () => {
  it('deep merges plain objects', () => {
    const to = { a: { b: 1 }, keep: true }
    const result = objectMerge(to, { a: { c: 2 } })

    expect(result.a).toEqual({ b: 1, c: 2 })
    expect(result.keep).toBe(true)
  })

  it('shallow copies arrays instead of merging', () => {
    const from = [3, 4]
    const result = objectMerge({ list: [1, 2] }, { list: from })

    expect(result.list).toEqual([3, 4])
    expect(result.list).not.toBe(from)
  })

  it('never overwrites with undefined values', () => {
    const result = objectMerge({ a: 1 }, { a: undefined })

    expect(result.a).toBe(1)
  })

  it('creates intermediate objects when the target key is undefined', () => {
    const result = objectMerge({}, { a: { b: { c: 1 } } })

    expect(result).toEqual({ a: { b: { c: 1 } } })
  })

  it('overwrites scalars, functions and non-pojo values', () => {
    const fn = () => 1
    const date = new Date(0)
    const result = objectMerge(
      { n: 1, fn: () => 0, d: new Date() },
      { n: 2, fn, d: date },
    )

    expect(result.n).toBe(2)
    expect(result.fn).toBe(fn)
    expect(result.d).toBe(date)
  })

  it('keeps values that are strictly equal', () => {
    const shared = { x: 1 }
    const result = objectMerge({ a: shared }, { a: shared })

    expect(result.a).toBe(shared)
  })

  it('merges into an empty from object without changes', () => {
    const to = { a: 1 }

    expect(objectMerge(to)).toEqual({ a: 1 })
  })
})
