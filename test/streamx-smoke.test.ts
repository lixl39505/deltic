import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
// @ts-expect-error -- gulp 5 ships no type declarations
import { dest, src } from 'gulp'
import { Transform } from 'streamx'

const dir = await mkdtemp(join(tmpdir(), 'deltic-smoke-'))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('pipes gulp5 src through a streamx transform into dest', async () => {
  await writeFile(join(dir, 'a.txt'), 'hello')

  const upper = new Transform({
    transform(file: { contents: Buffer }, cb: (err: null, data?: unknown) => void) {
      file.contents = Buffer.from(file.contents.toString('utf8').toUpperCase())
      cb(null, file)
    },
  })

  await new Promise<void>((resolve, reject) => {
    src(join(dir, 'a.txt').replace(/\\/g, '/'), { base: dir })
      .pipe(upper)
      .pipe(dest(dir))
      .on('finish', () => resolve())
      .on('error', reject)
  })

  expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('HELLO')
})
