import { describe, expect, it } from 'vitest'

import { createFileContext, createSession } from '../../../src/core/context.js'

// A minimal compiler stand-in: contexts inherit everything through the
// prototype chain, so a plain object with the public surface is enough here.
function fakeCompiler() {
  const compiler = {
    options: { timer: { now: () => 1234 } },
    baseDir: '/project',
    sourceDir: '/project/src',
    outputDir: '/project/dist',
    cacheDir: '/project/.deltic',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    resolve(request: string) {
      return `/project/src/${request}`
    },
    query(key: string, defaults: unknown) {
      return key === 'hit' ? defaults : 'value'
    },
    save() {},
    aCapability() {
      return 'capability'
    },
  }

  return compiler
}

describe('createSession', () => {
  it('builds a session sharing compiler state', () => {
    const compiler = fakeCompiler()
    const session = createSession(compiler as never)

    expect(session.startTime).toBe(1234)
    expect(session.endTime).toBe(-1)
    expect(session.files).toEqual([])
    expect(session.total).toBe(0)
    expect(session.totalCache).toBe(0)
    expect(session.totalHit).toBe(0)
    expect(session.profile).toBeNull()

    // inherited members
    expect(session.baseDir).toBe('/project')
    expect(
      (session as unknown as { aCapability(): string }).aCapability(),
    ).toBe('capability')
    expect(session.query('hit', 'fallback')).toBe('fallback')
    expect(session.query('other', 'fallback')).toBe('value')
  })

  it('session fields are independent between sessions', () => {
    const compiler = fakeCompiler()
    const a = createSession(compiler as never)
    const b = createSession(compiler as never)

    a.total = 5

    expect(b.total).toBe(0)
  })
})

describe('createFileContext', () => {
  it('wraps the compiler and the session', () => {
    const compiler = fakeCompiler()
    const session = createSession(compiler as never)
    const file = { path: '/project/src/a.js' } as never

    const context = createFileContext(compiler as never, file, session)

    expect(context.originalPath).toBe('/project/src/a.js')
    expect(context.customDeps).toEqual([])
    expect(context.depended).toBe(false)
    expect(context.session).toBe(session)
    expect(context.sourceDir).toBe('/project/src')
    expect(context.resolve('b.js')).toBe('/project/src/b.js')
  })

  it('custom deps arrays are per-file', () => {
    const compiler = fakeCompiler()
    const session = createSession(compiler as never)
    const file = { path: '/project/src/a.js' } as never

    const a = createFileContext(compiler as never, file, session)
    const b = createFileContext(compiler as never, file, session)

    a.customDeps.push('/project/src/.env/NAME')

    expect(b.customDeps).toEqual([])
  })
})
