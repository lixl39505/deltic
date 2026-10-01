import { describe, expect, it, vi } from 'vitest'

import { createLineRenderer, Progress } from '../../../src/core/progress.js'
import type { ProgressRenderer } from '../../../src/core/progress.js'

function fakeRenderer(): ProgressRenderer & {
  states: Array<{ total: number; done: number }>
  stopped: number
} {
  return {
    states: [],
    stopped: 0,
    render(state) {
      this.states.push({ ...state })
    },
    stop() {
      this.stopped += 1
    },
  }
}

describe('Progress', () => {
  it('renders append and increment states', () => {
    const renderer = fakeRenderer()
    const progress = new Progress(renderer)

    progress.append(10)
    progress.increment()
    progress.increment()

    expect(renderer.states).toEqual([
      { total: 10, done: 0 },
      { total: 10, done: 1 },
      { total: 10, done: 2 },
    ])
    expect(renderer.stopped).toBe(0)
  })

  it('stops the renderer when everything is done', () => {
    const renderer = fakeRenderer()
    const progress = new Progress(renderer)

    progress.append(1)
    progress.increment()

    expect(renderer.stopped).toBe(1)
  })

  it('reset clears counters and keeps rendering', () => {
    const renderer = fakeRenderer()
    const progress = new Progress(renderer)

    progress.append(1)
    progress.increment()
    progress.reset()
    progress.append(2)

    expect(renderer.states.at(-1)).toEqual({ total: 2, done: 0 })
  })

  it('skips rendering before any files were counted', () => {
    const renderer = fakeRenderer()
    const progress = new Progress(renderer)

    expect(() => progress.increment()).not.toThrow()
    expect(renderer.states).toEqual([])
  })

  it('stop forwards to the renderer', () => {
    const renderer = fakeRenderer()
    const progress = new Progress(renderer)

    progress.stop()

    expect(renderer.stopped).toBe(1)
  })
})

describe('createLineRenderer', () => {
  it('writes percentage lines', () => {
    const lines: string[] = []
    const renderer = createLineRenderer((text) => lines.push(text))

    renderer.render({ total: 4, done: 1 })
    renderer.render({ total: 4, done: 4 })

    expect(lines).toEqual(['[1/4] 25%\r', '[4/4] 100%\r'])
  })

  it('skips zero totals', () => {
    const lines: string[] = []
    const renderer = createLineRenderer((text) => lines.push(text))

    renderer.render({ total: 0, done: 0 })

    expect(lines).toEqual([])
  })

  it('stop only writes when something was rendered', () => {
    const lines: string[] = []
    const renderer = createLineRenderer((text) => lines.push(text))

    renderer.stop()
    expect(lines).toEqual([])

    renderer.render({ total: 1, done: 1 })
    renderer.stop()
    expect(lines).toEqual(['[1/1] 100%\r', '\n'])
  })

  it('defaults to writing to stdout', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const renderer = createLineRenderer((text) => {
      void process.stdout.write(text)
    })

    renderer.render({ total: 2, done: 1 })
    renderer.stop()

    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})
