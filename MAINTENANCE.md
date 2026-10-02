# MAINTENANCE

English · [简体中文](./MAINTENANCE.zh-CN.md)

Maintainer-facing notes: toolchain baseline, quality gates, architecture
rules, release checklist. User-facing documentation lives in
[README.md](./README.md); a runnable project is in [example/](./example).

## Toolchain baseline

| aspect | choice |
| --- | --- |
| runtime | Node >= 20 |
| package manager | pnpm (workspace root, `pnpm-workspace.yaml`) |
| language | TypeScript 7, compiled with native `tsc` — **no bundler**: `tsc -p tsconfig.build.json` → `dist/` + d.ts |
| module system | ESM-only (`"type": "module"`) |
| streaming | gulp 5 + streamx + vinyl 3 |
| state | better-sqlite3 → `.deltic/state.db` (SQLite) |
| test | vitest + `@vitest/coverage-istanbul` |

better-sqlite3 ships prebuilds — never enable its install scripts (that path
requires a Python toolchain). The published payload is `dist/` + `bin/` only.

## Commands

| command | purpose |
| --- | --- |
| `pnpm test` | vitest run |
| `pnpm test:coverage` | coverage with 100 % thresholds enforced |
| `pnpm test:e2e` | build + end-to-end suite (`test/e2e`) |
| `pnpm typecheck` | `tsc --noEmit` over the full project |
| `pnpm build` / `pnpm dev` | production build / watch build |
| `pnpm bench --files 20000` | synthetic end-to-end + store micro-benchmark |
| `pnpm format` | prettier |

## Quality gates

- **100 % coverage is enforced** (branches / functions / lines / statements,
  see `vitest.config.ts`). New code lands with exhaustive tests or not at
  all; loosening a threshold requires an explicit justification in the PR.
- `pnpm typecheck` must be clean; public API changes must keep the emitted
  `dist/*.d.ts` coherent.
- Error model: user-facing failures throw `ConfigError` / `CompileError` /
  `CapabilityMissingError` with readable messages. Wiring problems (unknown
  pipe, missing plugin capability) must fail at assembly/startup time, never
  mid-compile.
- State writes are queued in memory and committed in a single transaction per
  run (`flush()` / `stop()`) — keep new state access O(changed), never
  O(total).

## Architecture rules

- **Composition over inheritance.** Extend via plugins, pipes and hooks; the
  public surface exposes no subclassing hooks.
- **Capabilities sink into deltic instead of growing workarounds
  downstream.** When a consumer needs generic behavior, add a native
  option/factory here — e.g. `createConfigLoader` exists so downstream
  packages can load their own config files (different names, self-alias)
  instead of copying `loadConfig`.
- **Everything explicit.** No task exists unless `tasks` declares it; no
  implicit plugin or pipe registration.
- **Fine-grained cache invalidation.** Checksums bind per task/file scope;
  fallback invalidation goes through `extraDeps` with shallow per-item
  comparison — never a coarse global version bump.
- **Path handling**: follow README "Path rules" — use `toGlobPath`,
  `escapeGlobLiteral`, `joinGlob`, `stripBase`, `relativeId`; never hand-roll
  slash conversion or glob escaping.
- Commits follow the Chinese Conventional Commits format defined in
  `.agents/skills/git-commit-message/SKILL.md`.

## Release checklist

1. `pnpm install && pnpm typecheck && pnpm test:coverage`
2. `pnpm build && pnpm test:e2e`
3. `pnpm bench --files 20000` — compare against the README benchmark table.
   Warm builds and small incremental steps are the numbers users feel; a
   regression there is a bug even when tests pass. Investigate before
   shipping.
4. Bump the version and `pnpm publish`; verify with `npm pack --dry-run`
   that the tarball contains only `dist/` + `bin/`.
5. State compatibility: while 0.x, on-disk `.deltic/state.db` carries no
   migration guarantee. If a release changes the SQLite schema or the
   checksum namespaces, note it in the release notes ("delete `.deltic/`
   and rebuild").
