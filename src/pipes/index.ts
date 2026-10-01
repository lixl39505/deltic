import type { PipeDef, PipeFactory } from '../types.js'
import { aliasPipe } from './alias.js'
import { depAddPipe } from './dep-add.js'
import { dependPipe } from './depend.js'
import { envPipe } from './env.js'
import { jsonPipe, json5Pipe } from './json.js'
import { jsPipe } from './js.js'
import { oncePipe } from './once.js'
import { passThroughPipe } from './pass-through.js'
import { strJson5Pipe } from './str-json5.js'

export {
  aliasPipe,
  DEFAULT_ALIAS_STRATEGIES,
  type AliasPipeOptions,
  type AliasStrategy,
} from './alias.js'
export { depAddPipe, type DepAddPipeOptions } from './dep-add.js'
export { dependPipe, type DependPipeOptions } from './depend.js'
export { envPipe, type EnvPipeOptions } from './env.js'
export { jsonPipe, json5Pipe, type JsonPipeOptions } from './json.js'
export { jsPipe, type JsPipeOptions } from './js.js'
export { oncePipe, type OncePipeOptions } from './once.js'
export { passThroughPipe } from './pass-through.js'
export { strJson5Pipe, type StrJson5PipeOptions } from './str-json5.js'
export { createTransform, wrapPipeError, type PipeNext } from './stream.js'

/** Named builtin pipes available to task `use` lists. */
export const BUILTIN_PIPES: Record<string, PipeDef> = {
  alias: { name: 'alias', factory: aliasPipe as PipeFactory },
  env: { name: 'env', factory: envPipe as PipeFactory },
  depend: {
    name: 'depend',
    factory: dependPipe as PipeFactory,
    requires: ['dep-graph'],
  },
  'dep-add': {
    name: 'dep-add',
    factory: depAddPipe as unknown as PipeFactory,
    requires: ['dep-graph'],
  },
  once: {
    name: 'once',
    factory: oncePipe as PipeFactory,
    requires: ['compile-cache'],
  },
  'pass-through': {
    name: 'pass-through',
    factory: passThroughPipe as PipeFactory,
  },
  'str-json5': { name: 'str-json5', factory: strJson5Pipe as PipeFactory },
  js: { name: 'js', factory: jsPipe as PipeFactory, requires: ['dep-graph'] },
  json: {
    name: 'json',
    factory: jsonPipe as PipeFactory,
    requires: ['dep-graph'],
  },
  json5: {
    name: 'json5',
    factory: json5Pipe as PipeFactory,
    requires: ['dep-graph'],
  },
}
