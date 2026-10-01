import path from 'node:path'

import { remove } from '../utils/array.js'
import { definePlugin } from './define-plugin.js'
import type {
  DependOptions,
  DepNode,
  FileContext,
  FileRef,
  Matcher,
  PipeOptions,
  Plugin,
  Vinyl,
} from '../types.js'

// Relative id inside the given base, keeping the leading separator
// (e.g. `\js\a.js` on Windows, `/js/a.js` on POSIX). Paths outside the base
// stay absolute so ids remain stable regardless of string replacement quirks.
export function relativeId(filePath: string, base: string): string {
  const resolved = path.resolve(filePath)
  const baseResolved = path.resolve(base)

  if (resolved === baseResolved) {
    return path.sep
  }

  const rel = path.relative(baseResolved, resolved)

  if (rel.startsWith('..')) {
    return resolved
  }

  return path.sep + rel
}

// Depth-first walk over requiredBy edges with cycle protection. Iterative on
// purpose: dependency chains tens of thousands deep would overflow the call
// stack. Emits nodes in the same pre-order as the original recursive walk.
function traceUpstream(
  graph: Record<string, DepNode>,
  node: DepNode,
  visit: (upper: DepNode, from: DepNode) => void,
): void {
  const visited = new Set<string>([node.path])
  const stack: Array<{ current: DepNode; from: DepNode }> = [{ current: node, from: node }]

  while (stack.length > 0) {
    const { current, from } = stack.pop()!

    for (let index = current.requiredBy.length - 1; index >= 0; index--) {
      const upper = graph[current.requiredBy[index]!]

      if (upper === undefined || visited.has(upper.path)) {
        continue
      }

      visited.add(upper.path)
      visit(upper, from)
      stack.push({ current: upper, from: upper })
    }
  }
}

// Dependency graph: records `dependencies` per file while compiling, derives
// `requiredBy` on demand, and answers upstream queries for incremental builds.
export function depGraphPlugin(): Plugin {

  return definePlugin('dep-graph', (api) => {
    const { compiler, hooks, store } = api

    let graph: Record<string, DepNode> = {}

    const getFileId = (file: FileRef): string => {
      if (typeof file === 'string') {
        return relativeId(file, compiler.sourceDir)
      }

      const originalPath = (file.context as { originalPath?: string } | undefined)
        ?.originalPath

      return relativeId(originalPath ?? file.path, file.base)
    }

    const getGraphNodeById = (id: string): DepNode | undefined => graph[id]

    const getGraphNode = (file: FileRef, create = false): DepNode | undefined => {
      const id = getFileId(file)
      let node = graph[id]

      if (node === undefined && create) {
        node = graph[id] = { path: id, dependencies: [], requiredBy: [] }
      }

      return node
    }

    const depend = (file: Vinyl, dependOptions?: DependOptions): DepNode => {
      const node = getGraphNode(file, true)!
      const dirname = path.dirname(file.path)
      const extname = path.extname(file.path)
      const matchers: Matcher[] = dependOptions?.matchers ?? []
      const context = file.context as {
        depended: boolean
        customDeps: string[]
      }

      if (context.depended !== true) {
        node.dependencies = []
      }

      const dependencies = new Set(node.dependencies)
      const fresh: string[] = []
      const content = (file.contents as Buffer).toString('utf8')

      for (const matcher of matchers) {
        if (matcher instanceof RegExp) {
          // Reset lastIndex so shared global regexes stay reusable.
          matcher.lastIndex = 0

          let match: RegExpExecArray | null

          while ((match = matcher.exec(content)) !== null) {
            const request = match[1]

            if (request === undefined) {
              continue
            }

            const withExt =
              path.extname(request) === '' ? request + extname : request

            fresh.push(compiler.resolve(withExt, file.path))
          }
        } else {
          const deps = matcher(file, file.context as FileContext) || []

          for (const dep of deps) {
            fresh.push(path.extname(dep) === '' ? dep + extname : dep)
          }
        }
      }

      fresh.push(...context.customDeps)

      for (const dep of fresh) {
        dependencies.add(
          relativeId(path.resolve(dirname, dep), compiler.sourceDir),
        )
      }

      node.dependencies = Array.from(dependencies)
      context.depended = true
      store.graph.upsert([node])

      return node
    }

    const reverseDep = (): void => {
      const before = new Map(
        Object.values(graph).map((node) => [node.path, node.requiredBy.join('')]),
      )

      for (const node of Object.values(graph)) {
        node.requiredBy = []
      }

      for (const node of Object.values(graph)) {
        for (const dep of node.dependencies) {
          graph[dep]?.requiredBy.push(node.path)
        }
      }

      const dirty = Object.values(graph).filter(
        (node) => before.get(node.path) !== node.requiredBy.join(''),
      )

      if (dirty.length > 0) {
        store.graph.upsert(dirty)
      }
    }

    const traceReverseDep = (filePath: string): string[] => {
      const node = graph[getFileId(filePath)]
      const paths: string[] = []

      if (node !== undefined) {
        traceUpstream(graph, node, (upper) => {
          paths.push(upper.path)
        })
      }

      return paths
    }

    const addDep = (file: FileRef, paths: string | readonly string[]): void => {
      const list = typeof paths === 'string' ? [paths] : [...paths]
      const node = getGraphNode(file, true)!

      for (const item of list) {
        const id = relativeId(item, compiler.sourceDir)

        if (!node.dependencies.includes(id)) {
          node.dependencies.push(id)
        }
      }

      store.graph.upsert([node])
    }

    const removeDep = (file: FileRef, paths: string | readonly string[]): void => {
      const list = typeof paths === 'string' ? [paths] : [...paths]
      const node = getGraphNode(file)

      if (node === undefined) {
        return
      }

      for (const item of list) {
        const id = relativeId(item, compiler.sourceDir)

        remove(node.dependencies, id)

        const child = getGraphNodeById(id)

        if (child !== undefined) {
          remove(child.requiredBy, node.path)
          store.graph.upsert([child])
        }
      }

      store.graph.upsert([node])
    }

    const removeGraphNodes = (paths: string | readonly string[]): void => {
      const list = typeof paths === 'string' ? [paths] : [...paths]

      const ids = list.map((item) => getFileId(item))

      for (const id of ids) {
        delete graph[id]
      }

      store.graph.remove(ids)
    }

    hooks.on('init', () => {
      graph = store.graph.all()
    })

    hooks.on('clean', ({ expired }) => {
      removeGraphNodes(expired)

      if (expired.length > 0) {
        reverseDep()
      }
    })

    api.extendContext({
      capabilities: {
        getFileId,
        getGraphNode,
        getGraphNodeById,
        depend,
        reverseDep,
        traceReverseDep,
        addDep,
        removeDep,
        removeGraphNodes,
      },
    })
  })
}
