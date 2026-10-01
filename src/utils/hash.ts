import crypto from 'node:crypto'

export function checksum(content: string | Buffer, algorithm = 'sha1'): string {
  return crypto.createHash(algorithm).update(content).digest('hex')
}
