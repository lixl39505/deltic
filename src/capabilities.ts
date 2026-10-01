import type { FileContext, Vinyl } from './types.js'

/**
 * Capability interfaces below are injected into contexts at runtime by the
 * corresponding builtin plugins. They are merged into {@link Capabilities}
 * as optional members: a member is only present when its plugin is installed.
 */

// Injected by plugin "dep-graph".
export interface DepGraphCapabilities {
  /** @requires plugin depGraphPlugin() */
  depend(file: Vinyl, options?: DependOptions): DepNode
  /** @requires plugin depGraphPlugin() */
  addDep(file: FileRef, paths: string | readonly string[]): void
  /** @requires plugin depGraphPlugin() */
  removeDep(file: FileRef, paths: string | readonly string[]): void
  /** @requires plugin depGraphPlugin() */
  removeGraphNodes(paths: string | readonly string[]): void
  /** @requires plugin depGraphPlugin() */
  getGraphNode(file: FileRef, create?: boolean): DepNode | undefined
  /** @requires plugin depGraphPlugin() */
  getGraphNodeById(id: string): DepNode | undefined
  /** @requires plugin depGraphPlugin() */
  getFileId(file: FileRef): string
  /** @requires plugin depGraphPlugin() */
  reverseDep(): void
  /** @requires plugin depGraphPlugin() */
  traceReverseDep(filePath: string): string[]
}

// Injected by plugin "compile-cache".
export interface CompileCacheCapabilities {
  /**
   * Cache verdict for one scanned file: updates the mtime record and reports
   * whether the cache gate would drop it.  feeds the dependency-graph
   * env-pseudo-dependency check.
   *
   * @requires plugin compileCachePlugin()
   */
  checkFileCached(id: string, mtimeMs: number, file: FileRef): boolean
  /** @requires plugin compileCachePlugin() */
  checkFileChanged(file: Vinyl, settings?: CheckFileChangedSettings): CheckFileChangedResult
  /** @requires plugin compileCachePlugin() */
  removeCache(files: string | Vinyl | readonly (string | Vinyl)[]): void
}

// Injected by plugin "clean".
export interface CleanCapabilities {
  /** @requires plugin cleanPlugin() */
  isNewFile(filePath: string): boolean
  /** @requires plugin cleanPlugin() */
  cleanExpired(): Promise<string[]>
  /** @requires plugin cleanPlugin() */
  cleanSpec(paths: string | readonly string[]): Promise<string[]>
  /** @requires plugin cleanPlugin() */
  getOutputPath(paths: string | readonly string[]): string[]
  /** @requires plugin cleanPlugin() */
  saveFileList(): void
}

export interface DependOptions {
  matchers?: Matcher[]
}

export type Matcher =
  | RegExp
  | ((file: Vinyl, context: FileContext) => string[] | void)

export interface DepNode {
  path: string
  dependencies: string[]
  requiredBy: string[]
}

export type FileRef = string | Vinyl

export interface CheckFileChangedSettings {
  namespace?: string | ((file: Vinyl) => string)
  algorithm?: string
}

export interface CheckFileChangedResult {
  changed: boolean
  checksum: string
}
