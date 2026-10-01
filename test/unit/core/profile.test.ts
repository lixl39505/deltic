import { describe, expect, it } from 'vitest'

import { Profiler } from '../../../src/core/profile.js'
import type { ProfileOptions, Vinyl } from '../../../src/types.js'

function makeClock() {
  let now = 0
  return {
    now: () => now,
    tick(ms: number) {
      now += ms
    },
  }
}

function makeFile(path: string): Vinyl {
  return { path } as Vinyl
}

const enabled: ProfileOptions = { enabled: true, topPipes: 10, topFiles: 10 }
const disabled: ProfileOptions = { enabled: false, topPipes: 10, topFiles: 10 }

describe('Profiler', () => {
  it('returns null when disabled', () => {
    const clock = makeClock()
    const profiler = new Profiler(disabled, clock.now)

    profiler.startSession()
    profiler.startTask('js')

    expect(profiler.report()).toBeNull()
  })

  it('aggregates pipe timings with avg/max/maxFile', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    profiler.startTask('js')

    const a = makeFile('/src/a.js')
    const b = makeFile('/src/b.js')

    profiler.startFile(a)
    profiler.recordPipe('js', 'js:alias', a, 10)
    profiler.recordPipe('js', 'js:alias', a, 5)
    profiler.endTask('js')
    profiler.endFile('js', a, false)

    profiler.startFile(b)
    profiler.recordPipe('js', 'js:alias', b, 30)
    profiler.endFile('js', b, false)

    const report = profiler.report()!

    expect(report.pipes).toHaveLength(1)
    expect(report.pipes[0]).toMatchObject({
      task: 'js',
      pipe: 'js:alias',
      files: 3,
      totalMs: 45,
      avgMs: 15,
      maxMs: 30,
      maxFile: '/src/b.js',
    })
  })

  it('keeps per-file pipe breakdowns and sorts files by total', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()

    const slow = makeFile('/src/slow.js')
    const fast = makeFile('/src/fast.js')

    profiler.startFile(slow)
    clock.tick(40)
    profiler.recordPipe('js', 'js', slow, 40)
    profiler.endFile('js', slow, false)

    profiler.startFile(fast)
    clock.tick(5)
    profiler.recordPipe('js', 'js', fast, 5)
    profiler.endFile('js', fast, false)

    const report = profiler.report()!

    expect(report.files.map((file) => file.path)).toEqual([
      '/src/slow.js',
      '/src/fast.js',
    ])
    expect(report.files[0]!.pipes).toEqual({ js: 40 })
    expect(report.files[0]!.cached).toBe(false)
  })

  it('marks cached files and updates task counters', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    profiler.startTask('js')

    const file = makeFile('/src/a.js')
    profiler.startFile(file)
    profiler.endFile('js', file, true)

    const report = profiler.report()!

    expect(report.tasks.js).toEqual({ totalMs: 0, files: 1, cached: 1 })
    expect(report.files[0]!.cached).toBe(true)
    expect(report.files[0]!.pipes).toEqual({})
  })

  it('tracks task wall time', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    profiler.startTask('js')
    clock.tick(12)
    profiler.endTask('js')

    expect(profiler.report()!.tasks.js!.totalMs).toBe(12)
  })

  it('recordPipe without startFile skips the per-file breakdown', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.recordPipe('js', 'js', makeFile('/src/orphan.js'), 5)

    const report = profiler.report()!

    expect(report.pipes).toHaveLength(1)
    expect(report.files).toEqual([])
  })

  it('endTask without startTask is a no-op', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    expect(() => profiler.endTask('missing')).not.toThrow()
  })

  it('endFile without startFile still updates task counters', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    profiler.startTask('js')
    profiler.endFile('js', makeFile('/src/a.js'), false)

    const report = profiler.report()!

    expect(report.tasks.js!.files).toBe(1)
    expect(report.files).toEqual([])
  })

  it('endFile with unknown task is a no-op', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    profiler.startFile(makeFile('/src/a.js'))

    expect(() => profiler.endFile('missing', makeFile('/src/a.js'), false)).not.toThrow()
  })

  it('truncates the report to the configured top N', () => {
    const clock = makeClock()
    const profiler = new Profiler(
      { enabled: true, topPipes: 1, topFiles: 1 },
      clock.now,
    )

    profiler.startSession()

    for (const pipe of ['a', 'b', 'c']) {
      const file = makeFile(`/src/${pipe}.js`)
      profiler.startFile(file)
      profiler.recordPipe('js', pipe, file, pipe === 'b' ? 1 : 10)
      profiler.endFile('js', file, false)
    }

    const report = profiler.report()!

    expect(report.pipes).toHaveLength(1)
    expect(report.pipes[0]!.pipe).toBe('a')
    expect(report.files).toHaveLength(1)
  })

  it('reports empty structures for a session without files', () => {
    const clock = makeClock()
    const profiler = new Profiler(enabled, clock.now)

    profiler.startSession()
    clock.tick(7)

    const report = profiler.report()!

    expect(report.pipes).toEqual([])
    expect(report.files).toEqual([])
    expect(report.tasks).toEqual({})
    expect(report.totalMs).toBe(7)
  })
})
