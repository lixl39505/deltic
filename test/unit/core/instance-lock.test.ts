import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  INSTANCE_LOCK_FILE,
  InstanceLockError,
  acquireInstanceLock,
  isProcessAlive,
} from '../../../src/core/instance-lock.js'

let dir: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()

  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

async function tempDir(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'deltic-lock-'))
  return dir
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid!

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

  return pid
}

describe('isProcessAlive', () => {
  it('treats the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('treats an exited process as dead', async () => {
    expect(isProcessAlive(await deadPid())).toBe(false)
  })

  it('rejects pid values that cannot exist', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })

  it('treats EPERM as alive so foreign processes are never stolen', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })

    expect(isProcessAlive(1)).toBe(true)
  })
})

describe('acquireInstanceLock', () => {
  it('writes the lock, then releases it', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    const info = { cwd: '/project', version: '1.2.3' }
    const lock = await acquireInstanceLock(cacheDir, info)

    expect(lock.path).toBe(path.join(cacheDir, INSTANCE_LOCK_FILE))
    expect(lock.holder.pid).toBe(process.pid)

    const stored = JSON.parse(await readFile(lock.path, 'utf8'))
    expect(stored).toMatchObject({
      pid: process.pid,
      cwd: '/project',
      version: '1.2.3',
    })
    expect(typeof stored.startedAt).toBe('string')

    await lock.release()
    await lock.release() // idempotent
    await expect(stat(lock.path)).rejects.toThrow()
  })

  it('refuses to start while another live instance holds the lock', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    const first = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    })

    const error = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(InstanceLockError)
    expect((error as InstanceLockError).path).toBe(first.path)
    expect((error as InstanceLockError).holder.pid).toBe(process.pid)
    expect((error as Error).message).toContain(`pid ${process.pid}`)
    expect((error as Error).message).toContain(first.path)
  })

  it('takes over a lock whose owner is gone', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    await mkdir(cacheDir, { recursive: true })
    const lockPath = path.join(cacheDir, INSTANCE_LOCK_FILE)
    await writeFile(
      lockPath,
      JSON.stringify({ pid: await deadPid(), startedAt: 'yesterday', cwd: '/old', version: '0.0.1' }),
    )

    const lock = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    })

    expect(lock.holder.pid).toBe(process.pid)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(process.pid)
  })

  it('takes over corrupt, partial and non-object lock files', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    await mkdir(cacheDir, { recursive: true })
    const lockPath = path.join(cacheDir, INSTANCE_LOCK_FILE)

    for (const contents of ['not json at all', 'null', '{"startedAt":"x"}']) {
      await writeFile(lockPath, contents)

      const lock = await acquireInstanceLock(cacheDir, {
        cwd: '/project',
        version: '1.2.3',
      })

      expect(lock.holder.pid).toBe(process.pid)
      await lock.release()
    }
  })

  it('reports a live lock that is missing its metadata', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      path.join(cacheDir, INSTANCE_LOCK_FILE),
      JSON.stringify({ pid: process.pid }),
    )

    const error = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(InstanceLockError)
    expect((error as InstanceLockError).holder).toEqual({
      pid: process.pid,
      startedAt: '',
      cwd: '',
      version: '',
    })
  })

  it('keeps a lock that another instance took over', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    const lock = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    })
    const other = { pid: process.pid + 1, startedAt: 'now', cwd: '/other', version: '9.9.9' }
    await writeFile(lock.path, JSON.stringify(other))

    await lock.release()

    expect(JSON.parse(await readFile(lock.path, 'utf8')).pid).toBe(other.pid)
  })

  it('surfaces file system errors other than EEXIST', async () => {
    const cacheDir = path.join(await tempDir(), '.deltic')
    await mkdir(cacheDir, { recursive: true })
    // a read-only cache directory makes the exclusive create fail with EACCES
    await chmod(cacheDir, 0o500)

    try {
      await expect(
        acquireInstanceLock(cacheDir, { cwd: '/project', version: '1.2.3' }),
      ).rejects.toThrow(/EACCES|EPERM/)
    } finally {
      await chmod(cacheDir, 0o700)
    }
  })

  it('creates a missing cache directory', async () => {
    const cacheDir = path.join(await tempDir(), 'nested', '.deltic')
    const lock = await acquireInstanceLock(cacheDir, {
      cwd: '/project',
      version: '1.2.3',
    })

    expect((await stat(lock.path)).isFile()).toBe(true)
  })
})
