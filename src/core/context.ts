import type { Compiler } from '../compiler.js'
import type { FileContext, SessionContext, SessionOutput, Vinyl } from '../types.js'

// Contexts share the compiler through the prototype chain, so pipes can read
// live compiler state (options, dirs, capabilities) from file.context.
export function createSession(compiler: Compiler): SessionContext {
  const session = Object.create(compiler) as SessionContext

  session.startTime = compiler.options.timer.now()
  session.endTime = -1
  ;(session as { files: string[] }).files = []
  ;(session as { outputs: SessionOutput[] }).outputs = []
  session.total = 0
  session.totalCache = 0
  session.totalHit = 0
  session.profile = null

  return session
}

export function createFileContext(
  compiler: Compiler,
  file: Vinyl,
  session: SessionContext,
): FileContext {
  const context = Object.create(compiler) as FileContext

  ;(context as { originalPath: string }).originalPath = file.path
  ;(context as { customDeps: string[] }).customDeps = []
  context.depended = false
  ;(context as { session: SessionContext }).session = session

  return context
}
