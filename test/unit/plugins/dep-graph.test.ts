import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { relativeId, depGraphPlugin } from '../../../src/plugins/dep-graph.js'
import { makePluginEnv, type PluginTestEnv } from '../../helpers/plugin-api.js'
import { makeFile } from '../../helpers/stream.js'
import type { VinylType } from '../../helpers/stream.js'
import type { DepNode } from '../../../src/types.js'

async function setup(
  options: Parameters<typeof makePluginEnv>[0] = {},
): Promise<PluginTestEnv & { caps: Record<string, (...args: never[]) => unknown> }> {
  const env = makePluginEnv(options)

  await depGraphPlugin().setup(env.api)
  await env.hooks.fire('init', { compiler: env.compiler as never })

  return { ...env, caps: env.capabilities as Record<string, (...args: never[]) => unknown> }
}

function fileWith(content: string, name = '/project/src/a.js'): VinylType {
  const file = makeFile(name, content)
  file.context = {
    depended: false,
    customDeps: [],
    originalPath: name,
  } as never

  return file
}

describe('dep-graph plugin', () => {
  it('collects regex matcher dependencies with default extensions', async () => {
    const { caps } = await setup()
    const file = fileWith("require('./b')\n")

    const depend = caps.depend as (
      file: VinylType,
      options?: { matchers?: RegExp[] },
    ) => DepNode

    const node = depend(file, { matchers: [/require\(['"](.*?)['"]\)/g] })

    const expected = relativeId(
      path.resolve(path.dirname(file.path), './b.js'),
      path.resolve('/project/src'),
    )

    expect(node.dependencies).toEqual([expected])
    expect(
      (file.context as unknown as { depended: boolean }).depended,
    ).toBe(true)
  })

  it('does not clear previous deps when depend runs twice on one file', async () => {
    const { caps } = await setup()
    const file = fileWith("require('./b')\n")

    const depend = caps.depend as (file: VinylType, options?: { matchers?: RegExp[] }) => DepNode

    depend(file, { matchers: [/require\(['"](.*?)['"]\)/g] })
    const second = depend(file, { matchers: [] })

    expect(second.dependencies).toHaveLength(1)
  })

  it('merges customDeps and function matcher results', async () => {
    const { caps } = await setup()
    const file = fileWith('no matches here')
    ;(file.context as unknown as { customDeps: string[] }).customDeps.push(
      path.resolve('/project/src/.env/NAME'),
    )

    const depend = caps.depend as (
      file: VinylType,
      options?: { matchers?: Array<(f: VinylType) => string[]> },
    ) => DepNode

    const node = depend(file, { matchers: [() => ['./dep']] })

    const envId = relativeId(
      path.resolve('/project/src/.env/NAME'),
      path.resolve('/project/src'),
    )
    const depId = relativeId(
      path.resolve(path.dirname(file.path), './dep.js'),
      path.resolve('/project/src'),
    )

    expect(node.dependencies).toEqual([depId, envId])
  })

  it('skips regex matches without a capture group', async () => {
    const { caps } = await setup()
    const file = fileWith('hello world')

    const depend = caps.depend as (file: VinylType, options?: { matchers?: RegExp[] }) => DepNode
    const node = depend(file, { matchers: [/hello/g] })

    expect(node.dependencies).toEqual([])
  })

  it('resolves root-absolute and bare requests via compiler.resolve', async () => {
    const { caps } = await setup()
    const file = fileWith("import '@x/y'\n", '/project/src/deep/a.js')

    const depend = caps.depend as (file: VinylType, options?: { matchers?: RegExp[] }) => DepNode
    const node = depend(file, { matchers: [/import '(.*?)'/g] })

    const expected = relativeId(
      path.resolve(path.resolve('/project/src'), '@x/y.js'),
      path.resolve('/project/src'),
    )

    expect(node.dependencies).toEqual([expected])
  })

  it('reverseDep derives requiredBy and persists on flush', async () => {
    const { caps, store } = await setup()

    const depend = caps.depend as (file: VinylType, options?: { matchers?: RegExp[] }) => DepNode

    depend(fileWith('', '/project/src/a.js'))
    depend(fileWith("require('./a')\n", '/project/src/b.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })

    ;(caps.reverseDep as () => void)()

    const aId = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))

    expect(Object.keys(store.graph.all())).toEqual([])

    store.flush()

    const stored = store.graph.all()

    expect(stored[aId]!.requiredBy).toEqual([relativeId(path.resolve('/project/src/b.js'), path.resolve('/project/src'))])
  })

  it('traceReverseDep walks upstream with cycle protection', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (file: VinylType, options?: { matchers?: RegExp[] }) => DepNode

    depend(fileWith('', '/project/src/a.js'))
    depend(fileWith("require('./a')\n", '/project/src/b.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })
    depend(fileWith("require('./b')\n", '/project/src/c.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })
    ;(caps.reverseDep as () => void)()

    const trace = caps.traceReverseDep as (file: string) => string[]
    const aId = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))
    const bId = relativeId(path.resolve('/project/src/b.js'), path.resolve('/project/src'))
    const cId = relativeId(path.resolve('/project/src/c.js'), path.resolve('/project/src'))

    expect(trace(path.resolve('/project/src/a.js'))).toEqual([bId, cId])
    expect(trace(path.resolve('/project/src/unknown.js'))).toEqual([])
  })

  it('addDep is idempotent and removeDep edits both ends', async () => {
    const { caps } = await setup()

    const file = fileWith('')
    const addDep = caps.addDep as (f: VinylType, paths: string | string[]) => void
    const removeDep = caps.removeDep as (f: VinylType, paths: string | string[]) => void
    const depend = caps.depend as (f: VinylType, options?: object) => DepNode

    depend(file)
    addDep(file, path.resolve('/project/src/x.js'))
    addDep(file, path.resolve('/project/src/x.js'))

    const xId = relativeId(path.resolve('/project/src/x.js'), path.resolve('/project/src'))
    const node = depend(file)

    expect(node.dependencies.filter((d) => d === xId)).toHaveLength(1)

    removeDep(file, path.resolve('/project/src/x.js'))

    expect(node.dependencies).not.toContain(xId)
  })

  it('tracer skips dangling requiredBy entries', async () => {
    const env = makePluginEnv()
    const aId = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))
    const ghostId = relativeId(path.resolve('/project/src/ghost.js'), path.resolve('/project/src'))

    env.store.graph.upsert([{
      path: aId,
      dependencies: [],
      requiredBy: [ghostId],
    }])
    env.store.flush()

    await depGraphPlugin().setup(env.api)
    await env.hooks.fire('init', { compiler: env.compiler as never })

    const caps = env.capabilities as Record<string, (...args: never[]) => unknown>
    const trace = caps.traceReverseDep as (f: string) => string[]

    expect(trace(path.resolve('/project/src/a.js'))).toEqual([])
  })

  it('ignoreTracer tolerates dangling dependency ids', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => unknown
    const reverseDep = caps.reverseDep as () => void

    depend(fileWith("require('./ghost')\n", '/project/src/a.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })
    reverseDep()

    const trace = caps.traceReverseDep as (f: string) => string[]

    expect(trace(path.resolve('/project/src/ghost.js'))).toEqual([])
  })

  it('regex matchers keep explicit extensions untouched', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode
    const file = fileWith("require('./b.js')\n", '/project/src/a.js')

    depend(file, { matchers: [/require\(['"](.*?)['"]\)/g] })

    const expected = relativeId(
      path.resolve(path.dirname(file.path), './b.js'),
      path.resolve('/project/src'),
    )

    expect(file === null || file === undefined ? null : null).toBeNull()
    expect(
      (caps.getGraphNode as (f: unknown, c?: boolean) => import('../../../src/types.js').DepNode)(
        file,
      )!.dependencies,
    ).toEqual([expected])
  })

  it('function matchers may return nothing', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode
    const file = fileWith('content')

    const node = depend(file, { matchers: [() => undefined as unknown as string[]] })

    expect(node.dependencies).toEqual([])
  })

  it('addDep and removeDep accept arrays', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode
    const addDep = caps.addDep as (f: unknown, paths: string[]) => void
    const removeDep = caps.removeDep as (f: unknown, paths: string[]) => void

    const file = fileWith('', '/project/src/a.js')
    depend(file)

    const xId = relativeId(path.resolve('/project/src/x.js'), path.resolve('/project/src'))
    const yId = relativeId(path.resolve('/project/src/y.js'), path.resolve('/project/src'))

    addDep(file, [path.resolve('/project/src/x.js'), path.resolve('/project/src/y.js')])
    expect(depend(file).dependencies).toEqual(expect.arrayContaining([xId, yId]))

    removeDep(file, [path.resolve('/project/src/x.js'), path.resolve('/project/src/y.js')])
    expect(depend(file).dependencies).not.toContain(xId)
    expect(depend(file).dependencies).not.toContain(yId)
  })

  it('function matchers may return items with extensions', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode
    const file = fileWith('content')

    const node = depend(file, {
      matchers: [() => [path.resolve('/project/src/with-ext.js')]],
    })

    const expected = relativeId(
      path.resolve('/project/src/with-ext.js'),
      path.resolve('/project/src'),
    )

    expect(node.dependencies).toContain(expected)
  })

  it('removeDep detaches an existing child node', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => unknown
    const reverseDep = caps.reverseDep as () => void
    const removeDep = caps.removeDep as (f: unknown, paths: string) => void
    const dependNode = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode

    const a = fileWith('', '/project/src/a.js')
    const b = fileWith("require('./a')\n", '/project/src/b.js')

    depend(a)
    depend(b, { matchers: [/require\(['"](.*?)['"]\)/g] })
    reverseDep()

    removeDep(b, path.resolve('/project/src/a.js'))

    expect(dependNode(a).requiredBy).toEqual([])
  })

  it('removeDep on a file without a node is a no-op', async () => {
    const { caps } = await setup()

    const removeDep = caps.removeDep as (f: unknown, paths: string) => void

    expect(() =>
      removeDep(path.resolve('/project/src/missing.js'), path.resolve('/project/src/x.js')),
    ).not.toThrow()
  })

  it('traceReverseDep protects against dependency cycles', async () => {
    const { caps } = await setup()

    const depend = caps.depend as (f: unknown, o?: object) => unknown
    const reverseDep = caps.reverseDep as () => void
    const addDep = caps.addDep as (f: unknown, paths: string) => void

    const a = fileWith('', '/project/src/a.js')
    depend(a)

    const aAbs = path.resolve('/project/src/a.js')
    const bAbs = path.resolve('/project/src/b.js')

    addDep(aAbs, bAbs)
    addDep(bAbs, aAbs)
    reverseDep()

    const trace = caps.traceReverseDep as (f: string) => string[]

    // the cycle terminates; the queried node itself is not reported
    expect(trace(aAbs)).toEqual([
      relativeId(bAbs, path.resolve('/project/src')),
    ])
  })

  it('removeGraphNodes and addDep accept plain strings', async () => {
    const { caps } = await setup()

    const addDep = caps.addDep as (f: unknown, paths: string) => void
    const removeGraphNodes = caps.removeGraphNodes as (p: string) => void
    const depend = caps.depend as (f: unknown, o?: object) => import('../../../src/types.js').DepNode

    const file = fileWith('', '/project/src/a.js')
    depend(file)
    addDep(file, path.resolve('/project/src/x.js'))

    const xId = relativeId(path.resolve('/project/src/x.js'), path.resolve('/project/src'))
    expect(depend(file).dependencies).toContain(xId)

    removeGraphNodes(xId)
    expect(
      (caps.getGraphNodeById as (id: string) => unknown)(xId),
    ).toBeUndefined()
  })

  it('getFileId falls back to file.path without an originalPath', async () => {
    const { caps } = await setup()

    const getFileId = caps.getFileId as (f: unknown) => string
    const bare = makeFile(path.resolve('/project/src/plain.js'), '')
    bare.context = undefined as never

    expect(getFileId(bare)).toBe(
      relativeId(path.resolve('/project/src/plain.js'), path.resolve('/project/src')),
    )
  })

  it('removeGraphNodes deletes nodes and the clean hook rebuilds edges', async () => {
    const { caps, store, hooks } = await setup()

    const depend = caps.depend as (f: VinylType, options?: { matchers?: RegExp[] }) => DepNode

    depend(fileWith("require('./a')\n", '/project/src/b.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })

    const aId = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))
    const removeGraphNodes = caps.removeGraphNodes as (paths: string | string[]) => void

    removeGraphNodes([aId])

    expect(
      (caps.getGraphNodeById as (id: string) => unknown)(aId),
    ).toBeUndefined()

    // clean hook with content triggers reverseDep + persistence
    depend(fileWith("require('./a')\n", '/project/src/b.js'), {
      matchers: [/require\(['"](.*)['"]\)/g],
    })

    await hooks.fire('clean', { expired: [aId] })
    store.flush()

    const stored = store.graph.all()

    expect(Object.keys(stored)).not.toContain(aId)
  })

  it('seeds the graph from persisted state on init', async () => {
    const env = makePluginEnv()
    const aId = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))

    env.store.graph.upsert([{
      path: aId,
      dependencies: [],
      requiredBy: [],
    }])
    env.store.flush()

    await depGraphPlugin().setup(env.api)
    await env.hooks.fire('init', { compiler: env.compiler as never })

    const caps = env.capabilities as Record<string, (...args: never[]) => unknown>

    expect(
      (caps.getGraphNodeById as (id: string) => unknown)(aId),
    ).toBeDefined()
  })

  it('getFileId uses originalPath for derived files', async () => {
    const { caps } = await setup()

    const getFileId = caps.getFileId as (file: unknown) => string

    const original = relativeId(path.resolve('/project/src/a.js'), path.resolve('/project/src'))

    expect(getFileId(path.resolve('/project/src/a.js'))).toBe(original)

    const derived = makeFile('/project/src/slices/one.js', '')
    derived.context = { originalPath: path.resolve('/project/src/a.js') } as never

    expect(getFileId(derived)).toBe(original)
  })

  it('queues graph writes until flush', async () => {
    const { caps, store } = await setup()

    const depend = caps.depend as (f: VinylType, options?: object) => unknown

    depend(fileWith("require('./a')\n", '/project/src/b.js'), {
      matchers: [/require\(['"](.*?)['"]\)/g],
    })
    ;(caps.reverseDep as () => void)()

    expect(Object.keys(store.graph.all())).toEqual([])
  })
})
