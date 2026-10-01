import { describe, expect, it } from 'vitest'

import { checksum } from '../../../src/utils/hash.js'

describe('checksum', () => {
  it('computes sha1 hex by default', () => {
    expect(checksum('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  it('supports other algorithms', () => {
    expect(checksum('abc', 'md5')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  it('treats buffers and strings identically', () => {
    expect(checksum(Buffer.from('abc'))).toBe(checksum('abc'))
  })
})
