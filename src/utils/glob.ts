import fastGlob from 'fast-glob'

export interface ScanFilesOptions {
  ignore?: string[]
  /** Match dotfiles (default false, mirrors glob-stream). */
  dot?: boolean
  [key: string]: unknown
}

/**
 * Single directory walk shared by the progress counter and the task runners:
 * the result feeds `gulpSrc` as literal file paths so the tree is only
 * traversed once per run.
 */
export function scanFiles(
  patterns: string | readonly string[],
  options: ScanFilesOptions = {},
): string[] {
  const list = typeof patterns === 'string' ? [patterns] : [...patterns]

  return fastGlob.sync(list, { ...options, onlyFiles: true })
}
