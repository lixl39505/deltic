import path from 'node:path'

// Normalize separators so glob patterns behave consistently across platforms.
export function toGlobPath(input: string, sep: string = path.sep): string {
  const normalized = path.normalize(input)

  return sep === '\\' ? normalized.replace(/\\/g, '/') : normalized
}

// Characters that carry special meaning inside glob patterns.
const GLOB_MAGIC = /[*?[\]{}()!@+|]/g

/**
 * Escapes glob-magic characters in a LITERAL path (a directory or file that
 * must match as-is). Project paths like `ci/job(3) [win]/src` would otherwise
 * silently match nothing once embedded into a pattern.
 *
 * Uses character-class form (`(` → `[(]`, `]` → `[]]`) instead of backslash
 * escapes: glob v10 (gulp 5) defaults to windowsPathsNoEscape, so backslash
 * escapes are inert on Windows and would leak into fs paths verbatim.
 * Character classes behave identically in fast-glob, glob and tinyglobby.
 */
export function escapeGlobLiteral(input: string, sep: string = path.sep): string {
  const posix = toGlobPath(input, sep)

  return posix.replace(GLOB_MAGIC, (char) => (char === ']' ? '[]]' : `[${char}]`))
}

/**
 * Builds a pattern from a literal base directory and a glob relative part:
 * the base is escaped, the pattern part is kept as authored (backslashes in
 * it are normalized to forward slashes).
 */
export function joinGlob(literalBase: string, pattern: string, sep: string = path.sep): string {
  return `${escapeGlobLiteral(literalBase, sep)}/${pattern.replace(/\\/g, '/')}`
}

/**
 * Strips a base directory from a path, comparing case-insensitively (Windows
 * drive/project casing drifts freely). Returns the remainder including the
 * leading separator, or the original path when the base is not a prefix.
 */
export function stripBase(filePath: string, base: string): string {
  const posixPath = toGlobPath(filePath)
  const posixBase = toGlobPath(base).replace(/\/$/, '')

  const lowerPath = posixPath.toLowerCase()
  const lowerBase = posixBase.toLowerCase()

  if (lowerPath === lowerBase) {
    return '/'
  }

  if (!lowerPath.startsWith(`${lowerBase}/`)) {
    return filePath
  }

  return posixPath.slice(posixBase.length)
}
