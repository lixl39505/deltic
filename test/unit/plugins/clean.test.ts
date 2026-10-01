import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { relativeId } from '../../../src/plugins/dep-graph.js'
import { cleanPlugin } from '../../../src/plugins/clean.js'
import { makePluginEnv, type PluginTestEnv } from '../../helpers/plugin-api.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function makeProject(
  fileNames: string[] = [],
  makeOutputs: (ctx: { srcDir: string; outDir: string }) => Record<string, string[]> = () => ({}),
): Promise<{
  env: PluginTestEnv
  caps: Record<string, (...args: never[]) => unknown>
  srcDir: string
  outDir: string
}> {
  root = await mkdtemp(path.join(tmpdir(), 'deltic-clean-'))
  const srcDir = path.join(root, 'src')
  const outDir = path.join(root, 'dist')

  await mkdir(path.join(srcDir, 'js'), { recursive: true })
  await mkdir(path.join(outDir, 'js'), { recursive: true })
  await writeFile(path.join(srcDir, 'js', 'a.js'), 'a')
  await writeFile(path.join(srcDir, 'js', 'b.js'), 'b')

  const env = makePluginEnv()
  const compiler = env.compiler as unknown as {
    baseDir: string
    sourceDir: string
    outputDir: string
  }

  compiler.baseDir = root
  compiler.sourceDir = srcDir
  compiler.outputDir = outDir

  if (fileNames.length > 0) {
    env.store.files.add(
      fileNames.map((name) =>
        path.join(srcDir, 'js', name).replace(/\\/g, '/'),
      ),
    )
  }

  // Seed output records (and their artifacts on disk) exactly like real
  // compile runs would have left them.
  for (const [name, outs] of Object.entries(makeOutputs({ srcDir, outDir }))) {
    for (const out of outs) {
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, 'artifact')
    }

    env.store.outputs.upsert([
      [relativeId(path.join(srcDir, 'js', name), srcDir), outs],
    ])
  }

  env.store.flush()

  await cleanPlugin().setup(env.api)
  await env.hooks.fire('init', { compiler: env.compiler as never })

  return {
    env,
    caps: env.capabilities as Record<string, (...args: never[]) => unknown>,
    srcDir,
    outDir,
  }
}

const fwd = (value: string): string => value.replace(/\\/g, '/')
const srcPath = (name: string): string => fwd(path.join(root!, 'src', 'js', name))

describe('clean plugin', () => {
  it('removes recorded artifacts of deleted sources and refreshes the list', async () => {
    const { env, caps } = await makeProject(['a.js', 'c.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
      'b.js': [path.join(outDir, 'b.js')],
      'c.js': [path.join(outDir, 'c.js'), path.join(outDir, 'c.js.map')],
    }))

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([srcPath('c.js')])
    expect(existsSync(path.join(root!, 'dist', 'c.js'))).toBe(false)
    expect(existsSync(path.join(root!, 'dist', 'c.js.map'))).toBe(false)
    expect(existsSync(path.join(root!, 'dist', 'a.js'))).toBe(true)
    expect(env.logger.info).toHaveBeenCalled()

    env.store.flush()

    // the refreshed list mirrors the current source tree
    expect(env.store.files.all()).toEqual([srcPath('a.js'), srcPath('b.js')])
    // the expired source lost its output record
    expect(
      Object.keys(env.store.outputs.all()),
    ).not.toContain(relativeId(path.join(root!, 'src', 'js', 'c.js'), path.join(root!, 'src')))
  })

  it('returns empty when nothing expired and still refreshes the list', async () => {
    const { env, caps } = await makeProject(['a.js', 'b.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
      'b.js': [path.join(outDir, 'b.js')],
    }))

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([])

    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js'), srcPath('b.js')])
    expect(existsSync(path.join(root!, 'dist', 'a.js'))).toBe(true)
  })

  it('tolerates expired sources without output records', async () => {
    const { caps } = await makeProject(['a.js', 'c.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
    }))

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([srcPath('c.js')])
  })

  it('cleanSpec removes recorded artifacts for specific files', async () => {
    const { caps } = await makeProject(['a.js', 'b.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
      'b.js': [path.join(outDir, 'b.js')],
    }))

    await (caps.cleanSpec as (p: string) => Promise<string[]>)(
      path.join(root!, 'src', 'js', 'a.js'),
    )

    expect(existsSync(path.join(root!, 'dist', 'a.js'))).toBe(false)
    expect(existsSync(path.join(root!, 'dist', 'b.js'))).toBe(true)
    expect(existsSync(path.join(root!, 'dist', 'js'))).toBe(true)
  })

  it('cleans one-to-many outputs and prunes empty directories', async () => {
    const { caps } = await makeProject(['index.vue'], ({ outDir }) => ({
      'index.vue': [
        path.join(outDir, 'pages', 'index', 'index.wxml'),
        path.join(outDir, 'pages', 'index', 'index.js'),
      ],
    }))
    const sliceDir = path.join(root!, 'dist', 'pages', 'index')

    await (caps.cleanExpired as () => Promise<string[]>)()

    expect(existsSync(path.join(sliceDir, 'index.wxml'))).toBe(false)
    expect(existsSync(path.join(sliceDir, 'index.js'))).toBe(false)
    // both the component directory and its emptied parent are pruned
    expect(existsSync(sliceDir)).toBe(false)
    expect(existsSync(path.join(root!, 'dist', 'pages'))).toBe(false)
    expect(existsSync(path.join(root!, 'dist'))).toBe(true)
  })

  it('keeps directories that still contain untracked files', async () => {
    const { caps } = await makeProject(['index.vue'], ({ outDir }) => ({
      'index.vue': [path.join(outDir, 'pages', 'index', 'index.wxml')],
    }))
    const sliceDir = path.join(root!, 'dist', 'pages', 'index')
    writeFileSync(path.join(sliceDir, 'keep.txt'), 'keep')

    await (caps.cleanExpired as () => Promise<string[]>)()

    expect(existsSync(path.join(sliceDir, 'index.wxml'))).toBe(false)
    expect(existsSync(sliceDir)).toBe(true)
  })

  it('afterCompile replaces records and deletes vanished outputs', async () => {
    const { env } = await makeProject(['a.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.css')],
    }))

    writeFileSync(path.join(root!, 'dist', 'a.wxss'), 'renamed')

    await env.hooks.fire('afterCompile', {
      session: {
        outputs: [
          {
            source: path.join(root!, 'src', 'js', 'a.js'),
            path: path.join(root!, 'dist', 'a.wxss'),
          },
        ],
      },
    } as never)

    expect(existsSync(path.join(root!, 'dist', 'a.css'))).toBe(false)
    expect(existsSync(path.join(root!, 'dist', 'a.wxss'))).toBe(true)

    env.store.flush()

    expect(env.store.outputs.all()).toEqual({
      [relativeId(path.join(root!, 'src', 'js', 'a.js'), path.join(root!, 'src'))]: [
        path.join(root!, 'dist', 'a.wxss'),
      ],
    })
  })

  it('afterCompile ignores sessions without outputs', async () => {
    const { env } = await makeProject(['a.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
    }))

    await env.hooks.fire('afterCompile', {
      session: { outputs: [] },
    } as never)

    env.store.flush()

    expect(existsSync(path.join(root!, 'dist', 'a.js'))).toBe(true)
    expect(Object.keys(env.store.outputs.all())).toHaveLength(1)
  })

  it('cleanSpec ignores paths that are not tracked', async () => {
    const { env, caps } = await makeProject(['a.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
    }))

    const returned = await (caps.cleanSpec as (p: string) => Promise<string[]>)(
      path.join(root!, 'src', 'js', 'unknown.js'),
    )

    expect(returned).toEqual([path.join(root!, 'src', 'js', 'unknown.js')])

    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js')])
    expect(existsSync(path.join(root!, 'dist', 'a.js'))).toBe(true)
  })

  it('isNewFile reports membership in the file list', async () => {
    const { caps } = await makeProject(['a.js'])

    const isNewFile = caps.isNewFile as (p: string) => boolean

    expect(isNewFile(srcPath('a.js'))).toBe(false)
    expect(isNewFile(srcPath('zz.js'))).toBe(true)
  })

  it('saveFileList persists the current list on demand', async () => {
    const { env, caps } = await makeProject(['a.js'])

    ;(caps.saveFileList as () => void)()
    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js')])
  })

  it('handles expirations without new additions', async () => {
    const { caps, env } = await makeProject(['a.js', 'b.js'], ({ outDir }) => ({
      'a.js': [path.join(outDir, 'a.js')],
      'b.js': [path.join(outDir, 'b.js')],
    }))

    await rm(path.join(root!, 'src', 'js', 'b.js'), { force: true })

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([srcPath('b.js')])
    expect(existsSync(path.join(root!, 'dist', 'b.js'))).toBe(false)

    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js')])
    expect(existsSync(path.join(root!, 'dist', 'js'))).toBe(true)
  })
})
