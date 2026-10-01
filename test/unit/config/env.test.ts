import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadEnvFiles, parseEnvContent } from '../../../src/config/env.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('parseEnvContent', () => {
  it('parses KEY=VALUE pairs and ignores comments and blank lines', () => {
    expect(
      parseEnvContent('# comment\n; also comment\n\nA=1\n  B = two  \n'),
    ).toEqual({ A: '1', B: 'two' })
  })

  it('strips matching surrounding quotes', () => {
    expect(parseEnvContent('A="quoted value"\nB=\'single\'\nC=partial"')).toEqual({
      A: 'quoted value',
      B: 'single',
      C: 'partial"',
    })
  })

  it('keeps values containing equals signs', () => {
    expect(parseEnvContent('URL=http://x/?a=1')).toEqual({
      URL: 'http://x/?a=1',
    })
  })

  it('skips lines without a key', () => {
    expect(parseEnvContent('=novalue\nnoseparator\n=')).toEqual({})
  })

  it('strips a BOM marker', () => {
    expect(parseEnvContent('﻿A=1')).toEqual({ A: '1' })
  })
})

describe('loadEnvFiles', () => {
  it('applies .env → .env.local → .env.[mode] → .env.[mode].local precedence', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-env-'))

    await writeFile(path.join(dir, '.env'), 'A=base\nB=base\nMODELESS=yes')
    await writeFile(path.join(dir, '.env.local'), 'A=local')
    await writeFile(path.join(dir, '.env.production'), 'B=prod\nC=prod')
    await writeFile(path.join(dir, '.env.production.local'), 'C=prodlocal')

    expect(loadEnvFiles(dir, 'production')).toEqual({
      A: 'local',
      B: 'prod',
      C: 'prodlocal',
      MODELESS: 'yes',
    })
  })

  it('returns an empty object for a directory without env files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deltic-env-'))

    expect(loadEnvFiles(dir, 'development')).toEqual({})
  })
})
