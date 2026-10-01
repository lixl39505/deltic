import { describe, expect, it } from 'vitest'

import { dedup, groupBy, remove } from '../../../src/utils/array.js'

describe('dedup', () => {
  it('removes duplicates preserving order', () => {
    expect(dedup([1, 2, 1, 3, 2])).toEqual([1, 2, 3])
  })

  it('handles empty arrays', () => {
    expect(dedup([])).toEqual([])
  })
})

describe('remove', () => {
  it('removes by value and returns the spliced item', () => {
    const arr = ['a', 'b', 'c']

    expect(remove(arr, 'b')).toEqual(['b'])
    expect(arr).toEqual(['a', 'c'])
  })

  it('removes by predicate', () => {
    const arr = [1, 2, 3]

    expect(remove(arr, (v) => v > 1)).toEqual([2])
    expect(arr).toEqual([1, 3])
  })

  it('returns null when nothing matched', () => {
    expect(remove([1], 2)).toBeNull()
    expect(remove([1], () => false)).toBeNull()
  })
})

describe('groupBy', () => {
  it('groups by property name', () => {
    const items = [
      { type: 'a', v: 1 },
      { type: 'b', v: 2 },
      { type: 'a', v: 3 },
    ]

    expect(groupBy(items, 'type')).toEqual({
      a: [items[0], items[2]],
      b: [items[1]],
    })
  })

  it('groups by function result', () => {
    expect(groupBy([1, 2, 3, 4], (v) => (v % 2 === 0 ? 'even' : 'odd'))).toEqual({
      odd: [1, 3],
      even: [2, 4],
    })
  })

  it('stringifies numeric keys', () => {
    expect(groupBy([1, 10, 100], (v) => String(v).length)).toEqual({
      '1': [1],
      '2': [10],
      '3': [100],
    })
  })

  it('throws when iteratee is neither string nor function', () => {
    expect(() => groupBy([1], null as unknown as string)).toThrow(TypeError)
  })
})
