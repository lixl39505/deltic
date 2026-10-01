import { describe, expect, it } from 'vitest'

import { defineConfig } from '../../../src/config/define-config.js'

describe('defineConfig', () => {
  it('returns the same config object', () => {
    const config = { tasks: {} }
    expect(defineConfig(config)).toBe(config)
  })
})
