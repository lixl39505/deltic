import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Lock file written inside the project's cache directory in dev mode. */
export const INSTANCE_LOCK_FILE = 'dev.lock'

export interface InstanceLockHolder {
  pid: number
  startedAt: string
  cwd: string
  version: string
}

export interface InstanceLock {
  /** Absolute path of the lock file. */
  path: string
  holder: InstanceLockHolder
  /** Removes the lock file while this process still owns it. Idempotent. */
  release(): Promise<void>
}

export class InstanceLockError extends Error {
  readonly path: string
  readonly holder: InstanceLockHolder

  constructor(lockPath: string, holder: InstanceLockHolder) {
    super(
      `another deltic dev is already running for this project ` +
        `(pid ${holder.pid}, started ${holder.startedAt}, cwd ${holder.cwd})\n` +
        `stop it first, or delete ${lockPath} if that process is gone`,
    )
    this.name = 'InstanceLockError'
    this.path = lockPath
    this.holder = holder
  }
}

/**
 * A pid counts as alive when a signal can be delivered, and also when the
 * process exists but belongs to another user (kill then fails with EPERM).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function serialize(holder: InstanceLockHolder): string {
  return `${JSON.stringify(holder, null, 2)}\n`
}

// Unreadable, unparsable or partial locks are treated as stale: a dev lock is
// a convenience guard, and refusing to start because of a corrupt file would
// be worse than starting twice.
async function readHolder(lockPath: string): Promise<InstanceLockHolder | undefined> {
  let parsed: unknown

  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined
  }

  const { pid, startedAt, cwd, version } = parsed as Partial<InstanceLockHolder>

  if (typeof pid !== 'number') {
    return undefined
  }

  return {
    pid,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    cwd: typeof cwd === 'string' ? cwd : '',
    version: typeof version === 'string' ? version : '',
  }
}

function createLock(lockPath: string, holder: InstanceLockHolder): InstanceLock {
  return {
    path: lockPath,
    holder,
    release: async () => {
      const current = await readHolder(lockPath)

      // another instance took the lock over after we lost ours — leave it be
      if (current !== undefined && current.pid !== holder.pid) {
        return
      }

      await rm(lockPath, { force: true })
    },
  }
}

/**
 * Claims the single dev instance slot for a project. A second `deltic dev` on
 * the same project fails fast with {@link InstanceLockError} instead of
 * silently doubling every watcher event and fighting over the state database.
 * Locks whose owner is gone are taken over automatically.
 */
export async function acquireInstanceLock(
  cacheDir: string,
  info: { cwd: string; version: string },
): Promise<InstanceLock> {
  const lockPath = path.join(cacheDir, INSTANCE_LOCK_FILE)
  const holder: InstanceLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: info.cwd,
    version: info.version,
  }

  await mkdir(cacheDir, { recursive: true })

  try {
    // `wx` fails instead of overwriting, so two simultaneous starts cannot
    // both believe they won the slot
    await writeFile(lockPath, serialize(holder), { flag: 'wx' })
    return createLock(lockPath, holder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  const existing = await readHolder(lockPath)

  if (existing !== undefined && isProcessAlive(existing.pid)) {
    throw new InstanceLockError(lockPath, existing)
  }

  await writeFile(lockPath, serialize(holder))
  return createLock(lockPath, holder)
}
