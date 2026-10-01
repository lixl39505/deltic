import { describe, expect, it, vi } from 'vitest'

import { createLogger, type LoggerSink } from '../../../src/utils/logger.js'

describe('createLogger', () => {
  it('writes prefixed messages to the given sink', () => {
    const messages: string[] = []
    const sink: LoggerSink = { log: (message) => messages.push(message) }
    const logger = createLogger('my-scope', sink)

    logger.info('hello')
    logger.warn('careful')
    logger.error('boom')

    expect(messages.length).toBe(3)
    expect(messages.every((message) => message.includes('[my-scope]'))).toBe(true)
    expect(messages[0]).toContain('hello')
    expect(messages[1]).toContain('careful')
    expect(messages[2]).toContain('boom')
  })

  it('defaults to the console sink and the deltic scope', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createLogger()

    logger.info('via console')

    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]![0]).toContain('[deltic]')
    expect(spy.mock.calls[0]![0]).toContain('via console')

    spy.mockRestore()
  })
})
