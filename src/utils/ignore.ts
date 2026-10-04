import micromatch from 'micromatch'

import { toGlobPath } from './paths.js'

export type IgnoreMatcher = (filePath: string) => boolean

const MATCH_OPTIONS = { dot: true } as const

// chokidar 4+ dropped glob support for `ignored`: plain strings are compared
// literally, so a glob-style ignore pattern silently matches nothing and the
// ignored subtree keeps being watched and compiled. This factory turns the
// project's glob/regex ignore list into a predicate function with the
// chokidar-3 semantics deltic documents.
//
// Paths are normalized to forward slashes before matching, mirroring
// chokidar's internal normalization. micromatch's trailing-slash semantics
// make a tree pattern like 'dir/**' also match 'dir' itself, so directories
// are pruned and watchers never descend into ignored trees.
export function createIgnoreMatcher(
  patterns: readonly (string | RegExp)[],
): IgnoreMatcher {
  const globs = patterns.filter((entry): entry is string => typeof entry === 'string')
  const regexps = patterns.filter(
    (entry): entry is RegExp => entry instanceof RegExp,
  )

  return (filePath: string): boolean => {
    const normalized = toGlobPath(filePath)

    if (regexps.some((regexp) => regexp.test(normalized))) {
      return true
    }

    if (globs.length === 0) {
      return false
    }

    return micromatch.isMatch(normalized, globs, MATCH_OPTIONS)
  }
}
