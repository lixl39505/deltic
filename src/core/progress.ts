export interface ProgressState {
  total: number
  done: number
}

export interface ProgressRenderer {
  render(state: ProgressState): void
  stop(): void
}

// Single-line percentage renderer for terminals.
export function createLineRenderer(write: (text: string) => void): ProgressRenderer {
  let rendered = false

  return {
    render(state) {
      if (state.total <= 0) {
        return
      }

      rendered = true
      const percent = Math.floor((state.done / state.total) * 100)
      write(`[${state.done}/${state.total}] ${percent}%\r`)
    },
    stop() {
      if (!rendered) {
        return
      }

      rendered = false
      write('\n')
    },
  }
}

// Tracks compile progress for one compiler instance. `append` widens the
// total (initial scan, incremental batches); `increment` completes one file.
export class Progress {
  readonly #renderer: ProgressRenderer
  #total = 0
  #done = 0

  constructor(renderer: ProgressRenderer) {
    this.#renderer = renderer
  }

  reset(): void {
    this.#total = 0
    this.#done = 0
  }

  append(count: number): void {
    this.#total += count
    this.#render()
  }

  increment(): void {
    this.#done += 1
    this.#render()

    if (this.#total > 0 && this.#done >= this.#total) {
      this.#renderer.stop()
    }
  }

  stop(): void {
    this.#renderer.stop()
  }

  #render(): void {
    if (this.#total > 0) {
      this.#renderer.render({ total: this.#total, done: this.#done })
    }
  }
}
