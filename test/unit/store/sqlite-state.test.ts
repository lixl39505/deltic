import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteState } from '../../../src/store/sqlite-state.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('SqliteState (:memory:)', () => {
  it('persists meta values and falls back to defaults for missing keys', () => {
    const state = new SqliteState({ file: ':memory:' })

    expect(state.meta.get('missing', 'fallback')).toBe('fallback')

    state.meta.set('version', '9.9.9')
    state.meta.set('env', { A: 1 })
    state.flush()

    expect(state.meta.get('version', '')).toBe('9.9.9')
    expect(state.meta.get('env', {})).toEqual({ A: 1 })

    // overwrite
    state.meta.set('version', '1.0.0')
    state.flush()
    expect(state.meta.get('version', '')).toBe('1.0.0')

    state.close()
  })

  it('queues compiled rows and commits them on flush', () => {
    const state = new SqliteState({ file: ':memory:' })

    state.compiled.upsert([
      ['\\a.js', 111],
      ['\\b.js', 222],
    ])

    // uncommitted rows are not visible to reads
    expect(state.compiled.all()).toEqual({})

    state.flush()
    expect(state.compiled.all()).toEqual({ '\\a.js': 111, '\\b.js': 222 })

    // upsert over an existing row
    state.compiled.upsert([['\\a.js', 333]])
    state.flush()
    expect(state.compiled.all()['\\a.js']).toBe(333)

    // remove wins over a queued upsert; re-upsert wins over a queued remove
    state.compiled.upsert([['\\c.js', 444]])
    state.compiled.remove(['\\c.js'])
    state.flush()
    expect(state.compiled.all()['\\c.js']).toBeUndefined()

    state.compiled.remove(['\\b.js'])
    state.compiled.upsert([['\\b.js', 555]])
    state.flush()
    expect(state.compiled.all()['\\b.js']).toBe(555)

    state.compiled.remove(['\\a.js', '\\b.js'])
    state.flush()
    expect(state.compiled.all()).toEqual({})

    state.close()
  })

  it('flush without queued mutations is a no-op', () => {
    const state = new SqliteState({ file: ':memory:' })

    expect(() => state.flush()).not.toThrow()

    state.close()
  })

  it('groups checksums by scope and removes across scopes', () => {
    const state = new SqliteState({ file: ':memory:' })

    state.checksums.upsert('@', [['config', 'aaa']])
    state.checksums.upsert('npmDeps', [['\\a.js', 'bbb']])
    state.flush()

    expect(state.checksums.all()).toEqual({
      '@': { config: 'aaa' },
      npmDeps: { '\\a.js': 'bbb' },
    })

    // unchanged sums report as no-ops for the caller, rows stay as-is
    state.checksums.upsert('npmDeps', [['\\a.js', 'bbb']])
    state.flush()
    expect(state.checksums.all()['npmDeps']).toEqual({ '\\a.js': 'bbb' })

    // queued removals cancel queued upserts for the same path
    state.checksums.upsert('npmDeps', [['\\a.js', 'ccc']])
    state.checksums.removePaths(['\\a.js'])
    state.flush()

    // scopes without rows are absent from the snapshot
    expect(state.checksums.all()['npmDeps']).toBeUndefined()
    expect(state.checksums.all()).toEqual({ '@': { config: 'aaa' } })

    // removing an unknown path is harmless
    state.checksums.removePaths(['\\ghost.js'])
    state.flush()

    state.close()
  })

  it('adds and removes tracked files', () => {
    const state = new SqliteState({ file: ':memory:' })

    state.files.add(['C:/p/src/a.js', 'C:/p/src/b.js'])
    state.flush()
    expect(state.files.all()).toEqual(['C:/p/src/a.js', 'C:/p/src/b.js'])

    // add wins over a queued remove
    state.files.remove(['C:/p/src/a.js'])
    state.files.add(['C:/p/src/a.js'])
    state.flush()
    expect(state.files.all()).toEqual(['C:/p/src/a.js', 'C:/p/src/b.js'])

    state.files.remove(['C:/p/src/a.js'])
    state.flush()
    expect(state.files.all()).toEqual(['C:/p/src/b.js'])

    state.close()
  })

  it('stores graph nodes as JSON edge lists', () => {
    const state = new SqliteState({ file: ':memory:' })

    state.graph.upsert([
      { path: '\\a.js', dependencies: ['\\b.js'], requiredBy: [] },
      { path: '\\b.js', dependencies: [], requiredBy: ['\\a.js'] },
    ])

    expect(state.graph.all()).toEqual({})

    state.flush()
    expect(state.graph.all()['\\a.js']).toEqual({
      path: '\\a.js',
      dependencies: ['\\b.js'],
      requiredBy: [],
    })

    // upsert replaces edges
    state.graph.upsert([
      { path: '\\a.js', dependencies: [], requiredBy: [] },
    ])
    state.flush()
    expect(state.graph.all()['\\a.js']!.dependencies).toEqual([])

    // remove cancels a queued upsert
    state.graph.upsert([{ path: '\\c.js', dependencies: [], requiredBy: [] }])
    state.graph.remove(['\\c.js'])
    state.flush()
    expect(state.graph.all()['\\c.js']).toBeUndefined()

    state.graph.remove(['\\a.js', '\\b.js'])
    state.flush()
    expect(state.graph.all()).toEqual({})

    state.close()
  })
})

describe('SqliteState (file)', () => {
  it('creates the database next to the cache dir and reopens committed state', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-sqlite-'))
    const file = path.join(dir, 'nested', 'state.db')

    const first = new SqliteState({ file })
    first.compiled.upsert([['\\a.js', 111]])
    first.meta.set('version', '0.1.0')
    first.graph.upsert([{ path: '\\a.js', dependencies: [], requiredBy: [] }])
    first.checksums.upsert('npmDeps', [['x', 'y']])
    first.files.add(['C:/p/src/a.js'])
    first.close()

    expect(existsSync(file)).toBe(true)

    const second = new SqliteState({ file })

    expect(second.compiled.all()).toEqual({ '\\a.js': 111 })
    expect(second.meta.get('version', '')).toBe('0.1.0')
    expect(second.graph.all()['\\a.js']).toBeDefined()
    expect(second.checksums.all()).toEqual({ npmDeps: { x: 'y' } })
    expect(second.files.all()).toEqual(['C:/p/src/a.js'])

    second.close()
  })
})
