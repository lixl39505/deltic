import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CapabilityMissingError, ConfigError } from '../../../src/errors.js'
import { BUILTIN_PIPES } from '../../../src/pipes/index.js'
import { depGraphPlugin } from '../../../src/plugins/dep-graph.js'
import { definePlugin } from '../../../src/plugins/define-plugin.js'
import { normalizeTask, resolveOptions } from '../../../src/config/resolve.js'
import { preset } from '../../../src/preset/index.js'
import { escapeGlobLiteral } from '../../../src/utils/paths.js'
import type { Logger } from '../../../src/utils/logger.js'
import type { ResolvedOptions, UserConfig } from '../../../src/types.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function makeConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    baseDir: path.resolve('/project'),
    logger: silentLogger,
    tasks: {
      js: { test: '**/*.js', use: ['js'] },
    },
    ...overrides,
  }
}

describe('resolveOptions', () => {
  it('applies path defaults relative to baseDir', () => {
    const options = resolveOptions(makeConfig())

    expect(options.source).toBe('src')
    expect(options.sourceDir).toBe(path.resolve('/project/src'))
    expect(options.outputDir).toBe(path.resolve('/project/dist'))
    expect(options.cacheDir).toBe(path.resolve('/project/.deltic'))
    expect(options.mode).toBe('development')
    expect(options.config).toBe('')
  })

  it('assembles the global ignore list and dedups it', () => {
    const options = resolveOptions(
      makeConfig({
        ignore: ['**/generated/**', '**/generated/**'],
      }),
    )

    expect(options.ignore).toContain('**/node_modules/**')
    expect(options.ignore).toContain('**/generated/**')
    expect(options.ignore).toContain(
      `${path.resolve('/project/dist').replace(/\\/g, '/')}/**`,
    )
    expect(options.ignore).toContain(
      `${path.resolve('/project/.deltic').replace(/\\/g, '/')}/**`,
    )
    expect(new Set(options.ignore).size).toBe(options.ignore.length)
  })

  it('resolves alias values against baseDir but keeps http aliases', () => {
    const options = resolveOptions(
      makeConfig({ alias: { '@': './src', cdn: 'https://x.example.com/' } }),
    )

    expect(options.alias['@']).toBe(path.resolve('/project/src'))
    expect(options.alias.cdn).toBe('https://x.example.com/')
  })

  it('reads .env files by default, with explicit env overriding file values', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const envDir = await mkdtemp(path.join(tmpdir(), 'deltic-envdef-'))
    await writeFile(path.join(envDir, '.env'), 'FROM=envfile\nOVERRIDE=file')
    await writeFile(path.join(envDir, '.env.development'), 'OVERRIDE=modefile')

    try {
      const options = resolveOptions(
        makeConfig({ baseDir: envDir, env: { OVERRIDE: 'explicit' } }),
      )

      expect(options.loadEnv).toBe(true)
      expect(options.env.FROM).toBe('envfile')
      expect(options.env.OVERRIDE).toBe('explicit')
      expect(options.env.mode).toBe('development')
    } finally {
      await rm(envDir, { recursive: true, force: true })
    }
  })

  it('skips .env files when loadEnv is false', () => {
    const options = resolveOptions(makeConfig({ loadEnv: false, env: { A: 'x' } }))

    expect(options.loadEnv).toBe(false)
    expect(options.env).toEqual({ A: 'x', mode: 'development' })
  })

  it('resolves env values to strings and skips undefined', () => {
    const options = resolveOptions(
      makeConfig({ env: { N: 42 as unknown as string, B: true as unknown as string, SKIP: undefined } }),
    )

    expect(options.env.N).toBe('42')
    expect(options.env.B).toBe('true')
    expect(options.env.SKIP).toBeUndefined()
  })

  it('supports string ignores, factory plugins, cwd defaults and boolean loadEnv', async () => {
    const options = resolveOptions({
      tasks: {},
      ignore: 'single-glob',
      plugins: [() => ({ name: 'from-factory', setup: () => {} })],
      loadEnv: true,
    })

    expect(options.ignore).toContain('single-glob')
    expect(options.plugins.map((plugin) => plugin.name)).toContain('from-factory')
    expect(options.baseDir).toBe(process.cwd())
    expect(options.loadEnv).toBe(true)
  })

  it('supports the loadEnv object form with a custom dir and mode', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const envDir = await mkdtemp(path.join(tmpdir(), 'deltic-envobj-'))
    await writeFile(path.join(envDir, '.env.testing'), 'FROM=envfile')

    const options = resolveOptions(
      makeConfig({
        mode: 'testing',
        loadEnv: { dir: envDir, mode: 'testing' },
        env: { FROM: 'explicit' },
      }),
    )

    expect(options.loadEnv).toBe(true)
    expect(options.env.FROM).toBe('explicit')
    expect(options.env.mode).toBe('testing')

    await import('node:fs/promises').then((fs) =>
      fs.rm(envDir, { recursive: true, force: true }),
    )
  })

  it('installs default plugins when the user configures none', () => {
    const options = resolveOptions(makeConfig())

    expect(options.plugins.map((plugin) => plugin.name)).toEqual([
      'compile-cache',
      'dep-graph',
      'clean',
    ])
  })

  it('installs the builtin plugins even when the user configures plugins', () => {
    const options = resolveOptions(
      makeConfig({
        plugins: [depGraphPlugin()],
        tasks: { js: { test: '**/*.js', use: ['js'], cache: false } },
      }),
    )

    expect(options.plugins.map((plugin) => plugin.name)).toEqual([
      'compile-cache',
      'clean',
      'dep-graph',
    ])
  })

  it('installs the builtin plugins when plugins is empty', () => {
    const options = resolveOptions(makeConfig({ plugins: [] }))

    expect(options.plugins.map((plugin) => plugin.name)).toEqual([
      'compile-cache',
      'dep-graph',
      'clean',
    ])
  })

  it('lets a same-named plugin replace a builtin', () => {
    const replacement = definePlugin('compile-cache', () => {})
    const options = resolveOptions(makeConfig({ plugins: [replacement] }))

    expect(options.plugins.map((plugin) => plugin.name)).toEqual([
      'dep-graph',
      'clean',
      'compile-cache',
    ])
    expect(options.plugins.at(-1)).toBe(replacement)
  })

  it('lets a global plugin replace a builtin as well', () => {
    const replacement = definePlugin('clean', () => {})
    const options = resolveOptions(makeConfig(), {
      globalPlugins: [replacement],
    })

    expect(options.plugins.map((plugin) => plugin.name)).toEqual([
      'compile-cache',
      'dep-graph',
      'clean',
    ])
    expect(options.plugins.at(-1)).toBe(replacement)
  })

  it('merges builtin, global and user pipes', () => {
    const custom = () => ({ name: 'x' }) as never

    const options = resolveOptions(makeConfig({ pipes: { mine: custom } }), {
      globalPipes: { shared: custom },
    })

    expect(Object.keys(options.pipes)).toContain('js')
    expect(Object.keys(options.pipes)).toContain('shared')
    expect(Object.keys(options.pipes)).toContain('mine')
  })

  it('normalizes profile option shapes', () => {
    expect(resolveOptions(makeConfig()).profile).toEqual({
      enabled: false,
      topPipes: 10,
      topFiles: 20,
    })
    expect(resolveOptions(makeConfig({ profile: true })).profile.enabled).toBe(true)
    expect(
      resolveOptions(makeConfig({ profile: { topPipes: 3 } })).profile,
    ).toEqual({ enabled: true, topPipes: 3, topFiles: 20 })
    expect(
      resolveOptions(makeConfig({ profile: { enabled: false } })).profile.enabled,
    ).toBe(false)
  })

  it('normalizes the task set from preset output', () => {
    const options = resolveOptions(makeConfig({ tasks: preset() }))

    expect(Object.keys(options.tasks).sort()).toEqual([
      'assets',
      'js',
      'json',
      'json5',
    ])
    expect(options.tasks.js!.compileAncestor).toBe(true)
    expect(options.tasks.js!.cache).toBe(true)
    expect(options.tasks.js!.output).toBe(true)

    const expected = `${path
      .resolve('/project/src', '**/*.js')
      .replace(/\\/g, '/')}`

    expect(options.tasks.js!.test.globs).toEqual([expected])
  })
})

describe('normalizeTask', () => {
  const options: ResolvedOptions = resolveOptions(makeConfig())

  it('supports function tests and object tests', () => {
    const fromFn = normalizeTask(
      'a',
      { test: (o) => o.source, use: ['pass-through'] },
      options,
    )
    const fromObj = normalizeTask(
      'b',
      { test: { globs: ['a', 'b'], options: { dot: true } }, use: ['pass-through'] },
      options,
    )
    const fromSingle = normalizeTask(
      'c',
      { test: 'single.txt', use: ['pass-through'] },
      options,
    )

    // absolute globs are kept literal (escaped), not joined onto sourceDir
    const absolute = path.resolve('/elsewhere/src(x)', '**/*.js')
    const fromAbsolute = normalizeTask(
      'd',
      { test: absolute, use: ['pass-through'] },
      options,
    )

    expect(fromFn.test.globs[0]).toContain('src')
    expect(fromObj.test.globs).toHaveLength(2)
    expect(fromObj.test.options.dot).toBe(true)
    expect(fromSingle.test.globs).toHaveLength(1)
    expect(fromAbsolute.test.globs).toEqual([escapeGlobLiteral(absolute)])
  })

  it('merges task ignore with the global ignore', () => {
    const task = normalizeTask(
      'a',
      { test: '**/*', use: ['pass-through'], },
      options,
    )

    expect(task.test.options.ignore).toEqual(options.ignore)
  })

  it('normalizes task-level ignore separators', () => {
    const task = normalizeTask(
      'a',
      {
        test: { globs: '**/*', options: { ignore: ['sub\\gen\\**'] } },
        use: ['pass-through'],
      },
      options,
    )

    // `toGlobPath` rewrites `\` to `/` only where `path.sep` is `\`; POSIX
    // keeps the backslash because it is a legal filename character there.
    expect(task.test.options.ignore).toContain(
      path.sep === '\\' ? 'sub/gen/**' : 'sub\\gen\\**',
    )
  })

  it('accepts tuple and factory pipe refs with option factories', () => {
    const withTuple = normalizeTask(
      'a',
      { test: '**/*', use: [['str-json5', { space: 2 }]] },
      options,
    )
    const withFactoryOptions = normalizeTask(
      'b',
      { test: '**/*', use: [['str-json5', (o) => ({ space: (o.profile.topPipes ?? 0) + 1 })]] },
      options,
    )
    const withRawFactory = normalizeTask(
      'c',
      { test: '**/*', use: [BUILTIN_PIPES['pass-through']!.factory] },
      options,
    )

    expect(withTuple.use[0]!.options).toEqual({ space: 2 })
    expect(withFactoryOptions.use[0]!.options).toEqual({ space: 11 })
    expect(withRawFactory.use[0]!.name).toBe('passThroughPipe')
  })

  it('accepts a single pipe string and anonymous factories', () => {
    const single = normalizeTask(
      'a',
      { test: '**/*', use: 'pass-through' },
      options,
    )

    expect(single.use).toHaveLength(1)
    expect(single.use[0]!.name).toBe('pass-through')

    const anonymous = normalizeTask(
      'b',
      {
        test: '**/*',
        use: [[() => ({}) as never, { x: 1 }]],
      },
      options,
    )

    expect(anonymous.use[0]!.name).toBe('anonymous')
  })

  it('accepts raw factories with tuple options', () => {
    const task = normalizeTask(
      'a',
      {
        test: '**/*',
        use: [[BUILTIN_PIPES['str-json5']!.factory, { space: 2 }]],
      },
      options,
    )

    expect(task.use[0]!.name).toBe('strJson5Pipe')
    expect(task.use[0]!.options).toEqual({ space: 2 })
  })

  it('rejects empty and incomplete task definitions', () => {
    expect(() =>
      normalizeTask('a', undefined as unknown as UserConfig['tasks'][string], options),
    ).toThrow(ConfigError)

    expect(() =>
      normalizeTask('b', { use: ['pass-through'] } as unknown as UserConfig['tasks'][string], options),
    ).toThrow(ConfigError)

    expect(() =>
      normalizeTask('c', { test: '**/*' } as unknown as UserConfig['tasks'][string], options),
    ).toThrow(ConfigError)
  })

  it('rejects unknown pipes', () => {
    expect(() =>
      normalizeTask('a', { test: '**/*', use: ['nope'] }, options),
    ).toThrow(ConfigError)
  })

  it('rejects pipes with missing plugin requirements', () => {
    // builtin pipes can no longer miss their requirements — the builtin
    // plugins are always installed — so exercise the check with a custom pipe
    // that requires a plugin nobody registered
    const pipes = {
      ...options.pipes,
      'needs-third-party': {
        name: 'needs-third-party',
        factory: BUILTIN_PIPES['pass-through']!.factory,
        requires: ['third-party'],
      },
    }

    expect(() =>
      normalizeTask(
        'a',
        { test: '**/*', use: ['needs-third-party'], cache: false },
        options,
        pipes,
      ),
    ).toThrow(CapabilityMissingError)
  })
})

describe('preset', () => {
  it('drops tasks set to false and applies overrides', () => {
    const tasks = preset({
      assets: false,
      js: { compileAncestor: false },
      extra: { test: '**/*.txt', use: ['pass-through'] },
    })

    expect(Object.keys(tasks).sort()).toEqual(['extra', 'js', 'json', 'json5'])
    expect(tasks.js!.compileAncestor).toBe(false)
    expect(tasks.json!.use).toEqual(['json'])
  })

  it('rejects a cache-enabled task without the compile-cache plugin', () => {
    const options = resolveOptions(makeConfig())

    expect(() =>
      normalizeTask(
        'a',
        { test: '**/*', use: ['pass-through'] },
        options,
        options.pipes,
        new Set(),
      ),
    ).toThrow(CapabilityMissingError)
  })

  it('does not mutate the base definitions', () => {
    const a = preset()
    const b = preset({ js: { compileAncestor: false } })

    expect(a.js!.compileAncestor).toBe(true)
    expect(b.js!.compileAncestor).toBe(false)
  })
})
