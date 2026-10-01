# deltic

Gulp-based incremental compile toolkit — the generic core of
[weapp-gulp-service](https://github.com/lixl39505/weapp-gulp-service), rebuilt
in TypeScript 7 on Gulp 5 with no mini-program assumptions.

- **Incremental compilation** — buffered file watching, per-batch rebuilds,
  upstream tracing via a dependency graph
- **Compile cache** — mtime + config-checksum + env-value invalidation
- **Dependency graph** — matcher-based collection, reverse tracing with cycle
  protection
- **Plugin system** — named plugin objects, per-instance typed hooks,
  capability injection with assembly-time validation
- **Performance profiling** — `--profile` reports the slowest pipes and files

ESM-only · Node ≥ 20 · TypeScript 7 (`tsc`) · Vitest with 100 % branch and
function coverage enforced.

## Install

```bash
pnpm add -D deltic
```

## Quick start

```bash
deltic init          # creates deltic.config.ts
deltic build         # one-off compile
deltic dev           # compile, then watch (default command)
deltic build --profile
```

```ts
// deltic.config.ts
import { defineConfig, preset } from 'deltic'

export default defineConfig({
  alias: { '@': './src' },
  env: { API_URL: 'https://api.example.com' },
  // loadEnv: true,  // opt in to .env files — process.env is never touched
  // profile: true,
  tasks: preset(), // js / json / json5 (+ assets passthrough) — explicit, no implicit tasks
})
```

Everything is explicit: no task is registered unless `tasks` says so. Drop or
override preset entries (`preset({ assets: false })`), or declare your own:

```ts
tasks: {
  js: { test: '**/*.js', use: ['js'], compileAncestor: true },
  txt: { test: '**/*.txt', use: [['alias', { alias: { '@': './src' } }]] },
}
```

## Concepts

### Tasks

| field | default | meaning |
| --- | --- | --- |
| `test` | — | glob(s), `{ globs, options }`, or `(options) => …` — resolved against `source` |
| `use` | — | pipe names / factories, optionally `[pipe, options]` |
| `compileAncestor` | `false` | when this file changes, re-compile modules upstream of it |
| `cache` | `true` | evaluate the compile-cache pre-filter; hits skip the pipeline |
| `output` | `true` | write results to `output` |

Pipeline per task (cache misses only — hits are filtered before the pipeline starts): `scan → pre-filter? → context → pipes → dest? → progress`.

### Builtin pipes

`alias` · `env` · `depend` · `dep-add` · `once` · `pass-through` ·
`str-json5` · `js` · `json` · `json5`

Combo pipes (`js`, `json`) return multiple stages so `--profile` can time each
stage individually. Pipes declare capability requirements (`depend` needs the
`dep-graph` plugin); missing wiring fails at startup with a readable
`ConfigError`, not at runtime.

### Plugins

```ts
import { definePlugin } from 'deltic'

definePlugin('my-plugin', (api) => {
  const { compiler, hooks, logger, store } = api

  hooks.on('beforeCompile', async ({ session }) => { /* … */ })

  api.registerPipe('my-pipe', (options) => new Transform())
  api.extendContext({ capabilities: { myCapability: () => 42 } })
  // store.meta.set(...) — queued writes commit automatically after each run
})
```

Hooks: `init` · `clean` · `beforeCompile` · `afterCompile` · `taskError` —
async handlers run serially in registration order. `Compiler.use(plugin)`
registers a plugin globally (for instances created afterwards); passing
`plugins` in the config is instance-scoped. Default plugins:
`compile-cache`, `dep-graph`, `clean` — replace them by setting `plugins`.

### Compile cache

A cached file is re-compiled when any of these change: tool version, output
directory existence, config checksum (paths/env/tasks/infra excluded), its
mtime, or any `.env/X` value its sources reference.

### State storage (SQLite)

State lives in `.deltic/state.db` (SQLite via `better-sqlite3`): tables
`meta` (env snapshot, tool version, config checksum), `compiled`
(path → mtime), `checksums` (namespace → path → sum), `files` (tracked
sources) and `nodes` (dependency-graph edges). Plugins mutate in-memory
queues; `flush()` commits everything in one transaction at the end of each
run and on `stop()` — writes are O(changed), never O(total state).

### Profiling

`--profile` (or `profile: true`) attaches per-file/per-pipe timings, prints a
top-N table after each compile and exposes `session.profile` for
programmatic use.

### Benchmarks

`pnpm bench --files 20000` compiles a synthetic dependency chain end to end
and micro-benchmarks the store (Windows, NVMe, Node 24 — indicative only):

| scenario | 20 000 files |
| --- | --- |
| cold full build | 12.5 s |
| warm build (all cache hits) | **2.8 s** |
| incremental change, no upstream | **34 ms** |
| incremental change, ~10 000 traced upstream | 9.9 s |
| store flush (80 000 rows, one transaction) | 152 ms |
| startup load (compiled + graph) | 25 ms |

Scale limits found by the benchmark and fixed: the single-JSON storage
(replaced by SQLite), a recursive upstream tracer (stack overflow on deep
chains — now iterative), and the cache gate running inside the pipeline
(replaced by a stat-based pre-filter — warm runs no longer read file
contents at all).

## Configuration reference

| option | default | |
| --- | --- | --- |
| `source` / `output` | `src` / `dist` | directories relative to `baseDir` |
| `cacheDir` | `.deltic` | state directory (SQLite store) |
| `baseDir` | config dir or cwd | project root |
| `alias` | `{}` | resolved against `baseDir`; `http(s)` values pass through |
| `env` | `{}` | values substituted for `process.env.X` in sources |
| `loadEnv` | `false` | opt in: `.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local` |
| `mode` | `development` / `production` per command | injected as `env.mode` |
| `ignore` | `[]` | extra globs; output/cache/node_modules always ignored |
| `pipes` | — | instance pipe registry additions |
| `plugins` | defaults | replaces the default plugin set |
| `profile` | `false` | `boolean` or `{ enabled, topPipes, topFiles }` |
| `progress` | `true` | `[done/total] %` line renderer |
| `watch` | `{ debounceMs: 200 }` | plus passthrough chokidar options |
| `logger` / `timer` | built-ins | injectable for tests |

## Migrating from weapp-gulp-service (wgs)

| wgs | deltic |
| --- | --- |
| `wgs serve` / `wgs build` | `deltic dev` / `deltic build` (`upload`, `build:npm` removed with the mini-program stack) |
| `weapp.config.js`, auto-loaded tasks | `deltic.config.ts`, explicit `tasks` or `preset()` |
| `.wgs (JSON)` | `.deltic/state.db (SQLite)` |
| `cacheDir` `.wgs` | `.deltic` |
| `process.env` auto-pollution, ini env always on | env values from `env` (+ opt-in `loadEnv`); `process.env` untouched |
| alias rewrites stripped leading `../` | outputs `./`-prefixed same-directory paths (correct relative semantics) |
| `css.rename`, `px2rpx`, `lessVar`, sfc/mp tasks | removed with the mini-program stack — compose your own pipes |
| `gulp-mp-alias` global cache bug, `once` implicit-global checksum, json5 bad require | fixed |
| `taskerror` hook, `wgsResolve` | `taskError`, `resolve` |
| hooks global + `next()` callbacks | per-instance async hooks (`on` / `fire`) |
| prototype-patched plugins, global pipe cache | named plugins with `extendContext` / `registerPipe`, per-instance registries |
| compile-cache compared env against `process.env` | compares against resolved `env` (single source of truth) |

Behavioral notes: alias results now keep correct relative depth (including
`../`), bare `'@'` requests stay untouched, and same-directory aliases emit
`./lib` so dependency scanners can distinguish them from package imports.

## Path rules (Windows & CI — read before writing a plugin)

deltic normalizes everything internally, but path bugs compound at plugin
boundaries. The rules the core follows, and that plugins must follow too:

1. **Glob patterns use forward slashes, always.** Author patterns with `/`;
   deltic normalizes anything you pass (`ignore`, task `test` globs).
2. **Literal paths embedded into patterns must be escaped with
   `escapeGlobLiteral`** — CI workspaces like `job(3) [win]` silently match
   nothing otherwise. Never concatenate `dir + '/**'` by hand; use
   `joinGlob(dir, '**/*.js')`.
3. **Never backslash-escape globs.** gulp 5's glob engine runs with
   `windowsPathsNoEscape`, so `\(` is a literal backslash there while
   fast-glob treats it as an escape — class-form escaping (`(` → `[(]`,
   `]` → `[]]`) is the only form both engines agree on, which is what
   `escapeGlobLiteral` emits.
4. **Relative ids are platform-native** (`\js\a.js` / `/js/a.js`) — produced
   by `relativeId(path, base)`; never `path.relative(...).replace(/\\/g,'/')`
   into store keys, and never compare ids across machines.
5. **Watcher events arrive platform-native**; pipe them through
   `incrementCompile`/`cleanSpec` as-is instead of re-slashing.
6. Strip prefixes with `stripBase(path, base)` (case-insensitive, keeps
   original casing) — `String.replace(base, '')` breaks on case drift and
   replaces the first occurrence anywhere.

All helpers are exported from `'deltic'` (`toGlobPath`, `escapeGlobLiteral`,
`joinGlob`, `stripBase`, `relativeId`).

## Development

```bash
pnpm install
pnpm test            # vitest
pnpm test:coverage   # enforces branches/functions/lines/statements = 100 %
pnpm build           # tsc (TypeScript 7 native) → dist/ + d.ts
pnpm typecheck
```

See [example/](./example) for a runnable project.

## License

MIT
