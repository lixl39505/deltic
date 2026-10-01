import path from 'node:path'
import type { Transform } from 'streamx'

import { es5ImportReg, es6ImportReg, cssImportReg, cssUrlReg, htmlUrlReg } from '../constants.js'
import type { FileContext } from '../types.js'
import { createTransform, type BufferVinyl } from './stream.js'

export type AliasStrategy = 'js' | 'html' | 'css' | 'none'

export interface AliasPipeOptions {
  /** Alias map; falls back to `options.alias` from the compile context. */
  alias?: Record<string, string>
  /** extname (with dot) to replacement strategy; overrides the defaults. */
  strategies?: Record<string, AliasStrategy>
}

export const DEFAULT_ALIAS_STRATEGIES: Record<string, AliasStrategy> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'html',
  '.css': 'css',
  '.less': 'css',
  '.sass': 'css',
  '.scss': 'css',
  '.styl': 'css',
  '.stylus': 'css',
}

const STRATEGY_REGEXPS: Record<AliasStrategy, RegExp[]> = {
  js: [es6ImportReg, es5ImportReg],
  html: [htmlUrlReg],
  css: [cssImportReg, cssUrlReg],
  none: [],
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolveAlias(
  file: BufferVinyl,
  aliasMap: Record<string, string>,
  request: string,
): string | null {
  const slash = request.indexOf('/')

  // Bare alias requests without a subpath (e.g. `import '@'`) stay untouched.
  if (slash === -1) {
    return null
  }

  const key = request.slice(0, slash)
  const target = aliasMap[key]

  if (target === undefined) {
    return null
  }

  const rest = request.slice(slash)

  if (/^https?:\/\//.test(target)) {
    return target.replace(/\/+$/, '') + rest
  }

  let rel = path
    .relative(path.dirname(file.path), path.join(target, rest))
    .replace(/\\/g, '/')

  // Keep same-directory results explicitly relative ('./lib') so downstream
  // dependency scanners can tell them apart from bare package requests.
  if (!rel.startsWith('.')) {
    rel = `./${rel}`
  }

  return rel
}

// Rewrites alias-prefixed request paths (e.g. '@/utils/a') into relative
// paths. Falls back to the compiler-wide alias map when none is configured.
export function aliasPipe(options: AliasPipeOptions = {}): Transform {
  const { alias, strategies } = options
  const kindByExt: Record<string, AliasStrategy> = {
    ...DEFAULT_ALIAS_STRATEGIES,
    ...strategies,
  }

  let cachedMap: Record<string, string> | null = null
  let cachedPattern: RegExp | null = null

  const patternFor = (map: Record<string, string>): RegExp | null => {
    if (map === cachedMap) {
      return cachedPattern
    }

    const keys = Object.keys(map)
      .filter((key) => key !== '')
      .sort((a, b) => b.length - a.length)

    cachedMap = map
    cachedPattern =
      keys.length > 0
        ? new RegExp(`^(${keys.map(escapeRegExp).join('|')})`)
        : null

    return cachedPattern
  }

  return createTransform('alias', (file, next) => {
    const context = file.context as FileContext
    const aliasMap = alias ?? context.options.alias
    const kind = kindByExt[path.extname(file.path)] ?? 'none'

    if (kind === 'none') {
      next(null, file)
      return
    }

    const pattern = patternFor(aliasMap)

    if (pattern === null) {
      next(null, file)
      return
    }

    let content = file.contents.toString('utf8')

    for (const regexp of STRATEGY_REGEXPS[kind]) {
      content = content.replace(regexp, (match: string, request: string) => {
        if (!pattern.test(request)) {
          return match
        }

        const replaced = resolveAlias(file, aliasMap, request)

        // Replacement is passed as a function so `$` sequences in alias
        // targets are never interpreted as substitution patterns.
        return replaced === null ? match : match.replace(request, () => replaced)
      })
    }

    file.contents = Buffer.from(content)
    next(null, file)
  })
}
