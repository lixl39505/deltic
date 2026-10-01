import pc from 'picocolors'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LoggerSink {
  log(message: string): void
}

export function createLogger(scope = 'deltic', sink: LoggerSink = console): Logger {
  const prefix = pc.cyan(`[${scope}]`)

  return {
    info: (message) => sink.log(`${prefix} ${message}`),
    warn: (message) => sink.log(`${prefix} ${pc.yellow(message)}`),
    error: (message) => sink.log(`${prefix} ${pc.red(message)}`),
  }
}
