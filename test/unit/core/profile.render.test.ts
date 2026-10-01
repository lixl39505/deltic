import { describe, expect, it, vi } from 'vitest'

import { renderProfile } from '../../../src/core/profile.js'
import type { ProfileReport } from '../../../src/types.js'

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []

  return { lines, log: (line) => lines.push(line) }
}

describe('renderProfile', () => {
  it('renders pipes and files tables', () => {
    const { lines, log } = collect()
    const report: ProfileReport = {
      totalMs: 1250,
      pipes: [
        {
          task: 'js',
          pipe: 'js',
          files: 2,
          totalMs: 40,
          avgMs: 20,
          maxMs: 30,
          maxFile: '/src/big.js',
        },
      ],
      files: [
        {
          path: '/src/big.js',
          totalMs: 45,
          cached: false,
          pipes: { js: 30, 'cache-gate': 15 },
        },
      ],
      tasks: {},
    }

    renderProfile(report, log)

    const text = lines.join('\n')

    expect(text).toContain('Profile: total 1.25s')
    expect(text).toContain('Profile (pipes by total):')
    expect(text).toContain('js')
    expect(text).toContain('/src/big.js')
    expect(text).toContain('[js 30ms, cache-gate 15ms]')
  })

  it('omits empty tables and marks cached files', () => {
    const { lines, log } = collect()
    const report: ProfileReport = {
      totalMs: 5,
      pipes: [],
      files: [{ path: '/src/a.js', totalMs: 0.5, cached: true, pipes: {} }],
      tasks: {},
    }

    renderProfile(report, log)

    const text = lines.join('\n')

    expect(text).not.toContain('pipes by total')
    expect(text).toContain('Profile (files by total):')
    expect(text).toContain('[cached]')
    expect(text).toContain('0.5ms')
  })

  it('handles missing maxFile and uncached files without pipe timings', () => {
    const { lines, log } = collect()
    const report: ProfileReport = {
      totalMs: 0,
      pipes: [
        {
          task: 'task-with-a-very-long-name',
          pipe: 'pipe-name-even-longer-than-the-column',
          files: 1,
          totalMs: 0.001,
          avgMs: 0.001,
          maxMs: 0.001,
        },
      ],
      files: [{ path: '/src/x.js', totalMs: 1, cached: false, pipes: {} }],
      tasks: {},
    }

    expect(() => renderProfile(report, log)).not.toThrow()
    expect(lines[0]).toBe('Profile: total 0ms')
  })

  it('renders fast and slow durations differently', () => {
    const { lines, log } = collect()

    renderProfile(
      {
        totalMs: 99.4,
        pipes: [],
        files: [],
        tasks: {},
      },
      log,
    )

    expect(lines[0]).toBe('Profile: total 99.4ms')

    renderProfile({ totalMs: 100, pipes: [], files: [], tasks: {} }, log)

    expect(lines.at(-1)).toBe('Profile: total 0.10s')
  })

  it('pads columns narrower than their content', () => {
    const { lines, log } = collect()

    renderProfile(
      {
        totalMs: 150,
        pipes: [
          {
            task: 'a-very-long-task-name-indeed',
            pipe: 'a-pipe-name-that-is-far-too-long-for-the-column',
            files: 1234567,
            totalMs: 123456.789,
            avgMs: 0.1,
            maxMs: 999999.5,
            maxFile: '/a/max-file-path-longer-than-forty-four-characters.js',
          },
        ],
        files: [
          {
            path: '/a/max-file-path-longer-than-forty-four-characters.js',
            totalMs: 200,
            cached: false,
            pipes: {},
          },
        ],
        tasks: {},
      },
      log,
    )

    const text = lines.join('\n')

    expect(text).toContain('a-pipe-name-that-is-far-too-long-for-the-column')
    expect(text).toContain('123.46s')
    expect(lines.at(-1)).toContain('a/max-file-path-longer-than-forty-four-characters.js')
  })

  it('accepts any log sink', () => {
    const spy = vi.fn()

    renderProfile({ totalMs: 1, pipes: [], files: [], tasks: {} }, spy)

    expect(spy).toHaveBeenCalledOnce()
  })
})
