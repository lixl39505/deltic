export interface CompileErrorOptions {
  file?: string
  cause?: unknown
}

export class CompileError extends Error {
  readonly file?: string

  constructor(message: string, options: CompileErrorOptions = {}) {
    super(
      options.file === undefined ? message : `${message}\nGulpFile: ${options.file}`,
      { cause: options.cause },
    )
    this.name = 'CompileError'
    this.file = options.file
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class CapabilityMissingError extends ConfigError {
  readonly pipe: string
  readonly requires: readonly string[]

  constructor(pipe: string, requires: readonly string[]) {
    super(
      `pipe "${pipe}" requires plugin(s) ${requires
        .map((name) => `"${name}"`)
        .join(', ')}, which are not installed. Add them to "plugins" in your deltic config.`,
    )
    this.name = 'CapabilityMissingError'
    this.pipe = pipe
    this.requires = requires
  }
}

export class UnknownHookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownHookError'
  }
}
