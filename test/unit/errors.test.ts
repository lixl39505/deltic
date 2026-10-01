import { describe, expect, it } from 'vitest'

import {
  CapabilityMissingError,
  CompileError,
  ConfigError,
} from '../../src/errors.js'

describe('CompileError', () => {
  it('keeps the message untouched when no file is attached', () => {
    const error = new CompileError('compile failed')

    expect(error.name).toBe('CompileError')
    expect(error.message).toBe('compile failed')
    expect(error.file).toBeUndefined()
  })

  it('appends the file location to the message', () => {
    const error = new CompileError('compile failed', { file: '/src/a.js' })

    expect(error.message).toBe('compile failed\nGulpFile: /src/a.js')
    expect(error.file).toBe('/src/a.js')
  })

  it('preserves the original error as cause', () => {
    const cause = new Error('root cause')
    const error = new CompileError('compile failed', { cause })

    expect(error.cause).toBe(cause)
  })
})

describe('ConfigError', () => {
  it('exposes a dedicated name', () => {
    const error = new ConfigError('bad config')

    expect(error.name).toBe('ConfigError')
    expect(error.message).toBe('bad config')
  })
})

describe('CapabilityMissingError', () => {
  it('lists the missing plugins in the message', () => {
    const error = new CapabilityMissingError('depend', ['dep-graph', 'clean'])

    expect(error).toBeInstanceOf(ConfigError)
    expect(error.name).toBe('CapabilityMissingError')
    expect(error.pipe).toBe('depend')
    expect(error.requires).toEqual(['dep-graph', 'clean'])
    expect(error.message).toContain('"depend"')
    expect(error.message).toContain('"dep-graph", "clean"')
  })
})
