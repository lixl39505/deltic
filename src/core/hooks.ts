import { UnknownHookError } from '../errors.js'
import type {
  HookHandler,
  HookName,
  HookPayloads,
  HookRegistry,
  Unsubscribe,
} from '../types.js'

const KNOWN_HOOKS: readonly HookName[] = [
  'init',
  'clean',
  'beforeCompile',
  'afterCompile',
  'taskError',
]

type StoredHandler = HookHandler<HookName>

// Per-instance hook registry. Handlers run serially in registration order;
// an async handler is awaited, and a rejected handler rejects the whole fire.
export class HookRegistryImpl implements HookRegistry {
  readonly #handlers = new Map<HookName, StoredHandler[]>()

  #assertKnown(name: HookName): void {
    if (!KNOWN_HOOKS.includes(name)) {
      throw new UnknownHookError(
        `unknown hook "${String(name)}", expected one of: ${KNOWN_HOOKS.join(', ')}`,
      )
    }
  }

  on<K extends HookName>(name: K, handler: HookHandler<K>): Unsubscribe {
    this.#assertKnown(name)

    const stored = handler as StoredHandler
    const list = this.#handlers.get(name)

    if (list === undefined) {
      this.#handlers.set(name, [stored])
    } else {
      list.push(stored)
    }

    return () => {
      const current = this.#handlers.get(name)
      const index = current?.indexOf(stored) ?? -1

      if (index >= 0) {
        current!.splice(index, 1)

        if (current!.length === 0) {
          this.#handlers.delete(name)
        }
      }
    }
  }

  async fire<K extends HookName>(name: K, payload: HookPayloads[K]): Promise<void> {
    this.#assertKnown(name)

    const list = [...(this.#handlers.get(name) ?? [])]

    for (const handler of list) {
      await handler(payload)
    }
  }

  listenerCount<K extends HookName>(name: K): number {
    return this.#handlers.get(name)?.length ?? 0
  }
}
