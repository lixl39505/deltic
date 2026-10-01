import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { scanFiles } from '../../../src/utils/glob.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('scanFiles', () => {
  it('returns files from a single string pattern', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-glob-'))
    await writeFile(path.join(dir, 'a.js'), 'a')
    await writeFile(path.join(dir, 'b.js'), 'b')

    const pattern = path.join(dir, '*.js').split(path.sep).join('/')

    expect(scanFiles(pattern)).toHaveLength(2)
    expect(scanFiles([pattern])).toHaveLength(2)
  })

  it('applies ignore patterns', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-glob-'))
    await mkdir(path.join(dir, 'gen'), { recursive: true })
    await writeFile(path.join(dir, 'a.js'), 'a')
    await writeFile(path.join(dir, 'gen', 'b.js'), 'b')

    const pattern = path.join(dir, '**/*.js').split(path.sep).join('/')

    expect(scanFiles(pattern, { ignore: ['**/gen/**'] })).toEqual([
      path.join(dir, 'a.js').split(path.sep).join('/'),
    ])
  })

  it('excludes dotfiles unless dot is enabled', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-glob-'))
    await writeFile(path.join(dir, 'a.js'), 'a')
    await writeFile(path.join(dir, '.hidden.js'), 'h')

    const pattern = path.join(dir, '*.js').split(path.sep).join('/')

    expect(scanFiles(pattern)).toHaveLength(1)
    expect(scanFiles(pattern, { dot: true })).toHaveLength(2)
  })

  it('excludes directories (only files feed the pipeline)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-glob-'))
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'sub', 'a.js'), 'a')

    const pattern = path.join(dir, '**/*.js').split(path.sep).join('/')

    expect(scanFiles(pattern)).toEqual([
      path.join(dir, 'sub', 'a.js').split(path.sep).join('/'),
    ])
  })

  it('tolerates patterns that match nothing', () => {
    expect(scanFiles('**/*.definitely-no-match')).toEqual([])
  })
})
