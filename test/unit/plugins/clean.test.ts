import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
  await writeFile(path.join(outDir, 'js', 'a.js'), 'a-out')
  await writeFile(path.join(outDir, 'js', 'b.js'), 'b-out')
  await writeFile(path.join(outDir, 'js', 'c.js'), 'c-out')

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
    env.store.flush()
  }

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
  it('removes artifacts of deleted sources and refreshes the list', async () => {
    const { env, caps, outDir } = await makeProject(['a.js', 'c.js'])

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([srcPath('c.js')])
    expect(existsSync(path.join(outDir, 'js', 'c.js'))).toBe(false)
    expect(existsSync(path.join(outDir, 'js', 'a.js'))).toBe(true)
    expect(env.logger.info).toHaveBeenCalled()

    env.store.flush()

    // the refreshed list mirrors the current source tree
    expect(env.store.files.all()).toEqual([srcPath('a.js'), srcPath('b.js')])
  })

  it('returns empty when nothing expired and still refreshes the list', async () => {
    const { env, caps } = await makeProject(['a.js', 'b.js'])

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([])

    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js'), srcPath('b.js')])
  })

  it('cleanSpec removes artifacts for specific files', async () => {
    const { caps, outDir } = await makeProject()

    await (caps.cleanSpec as (p: string) => Promise<string[]>)(
      path.join(root!, 'src', 'js', 'a.js'),
    )

    expect(existsSync(path.join(outDir, 'js', 'a.js'))).toBe(false)
    expect(existsSync(path.join(outDir, 'js', 'b.js'))).toBe(true)
  })

  it('getOutputPath maps sources onto output globs', async () => {
    const { caps } = await makeProject()

    const globs = (caps.getOutputPath as (p: string) => string[])(
      path.join(root!, 'src', 'js', 'a.js'),
    )

    expect(globs).toEqual([fwd(path.join(root!, 'dist', 'js', 'a')) + '.*'])
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
    const { caps, outDir, env } = await makeProject(['a.js', 'b.js'])

    await rm(path.join(root!, 'src', 'js', 'b.js'), { force: true })

    const expired = await (caps.cleanExpired as () => Promise<string[]>)()

    expect(expired).toEqual([srcPath('b.js')])
    expect(existsSync(path.join(outDir, 'js', 'b.js'))).toBe(false)

    env.store.flush()

    expect(env.store.files.all()).toEqual([srcPath('a.js')])
  })
})
