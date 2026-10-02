# deltic

[English](./README.md) · 简体中文

基于 Gulp 的增量编译工具集 —— 将增量编译、编译缓存、依赖图重建与插件系统封装为可复用的库与 CLI。TypeScript 7 + Gulp 5，不预设你在构建什么。

- **增量编译** —— 缓冲式文件监听、按批重建、基于依赖图的上游追踪
- **编译缓存** —— mtime + 配置校验和 + 环境变量值 三重失效判定
- **依赖图** —— 基于 matcher 的收集、带环保护的反向追踪
- **插件系统** —— 具名插件对象、按实例的类型化 hooks、装配期校验的能力注入
- **性能剖析** —— `--profile` 报告最慢的管道与文件

仅支持 ESM · Node ≥ 20 · TypeScript 7（`tsc`）· Vitest 强制 100 % 分支与函数覆盖率。

## 安装

```bash
pnpm add -D deltic
```

## 快速上手

```bash
deltic init          # 创建 deltic.config.ts
deltic build         # 一次性编译
deltic dev           # 编译后进入监听（默认命令）
deltic build --profile
```

```ts
// deltic.config.ts
import { defineConfig, preset } from 'deltic'

export default defineConfig({
  alias: { '@': './src' },
  env: { API_URL: 'https://api.example.com' },
  // loadEnv: false, // .env 文件默认加载 —— 按此方式关闭（process.env 永远不会被改动）
  // profile: true,
  tasks: preset(), // js / json / json5（+ assets 透传）—— 显式声明，无隐式任务
})
```

一切皆显式：`tasks` 未声明的任务不会被注册。可以删减或覆盖 preset 条目
（`preset({ assets: false })`），也可以完全自己声明：

```ts
tasks: {
  js: { test: '**/*.js', use: ['js'], compileAncestor: true },
  txt: { test: '**/*.txt', use: [['alias', { alias: { '@': './src' } }]] },
}
```

## 核心概念

### 任务（Task）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `test` | — | glob、`{ globs, options }` 或 `(options) => …` —— 相对 `source` 解析 |
| `use` | — | 管道名 / 工厂，可选 `[pipe, options]` 形式 |
| `compileAncestor` | `false` | 该文件变更时，重新编译依赖它的上游模块 |
| `cache` | `true` | 启用编译缓存预过滤；命中则跳过整个管道 |
| `output` | `true` | 将结果写入 `output` |

每个任务的流水线（仅缓存未命中时执行 —— 命中的文件在管道开始前就被过滤掉）：
`scan → pre-filter? → context → pipes → dest? → progress`。

### 内置管道

`alias` · `env` · `depend` · `dep-add` · `once` · `pass-through` ·
`str-json5` · `js` · `json` · `json5`

组合管道（`js`、`json`）会返回多个阶段，`--profile` 可以分别计时每个阶段。
管道可以声明能力依赖（`depend` 需要 `dep-graph` 插件）；缺失的装配会在启动时
以可读的 `ConfigError` 失败，而不是在运行中途。

### 插件

```ts
import { definePlugin } from 'deltic'

definePlugin('my-plugin', (api) => {
  const { compiler, hooks, logger, store } = api

  hooks.on('beforeCompile', async ({ session }) => { /* … */ })

  api.registerPipe('my-pipe', (options) => new Transform())
  api.extendContext({ capabilities: { myCapability: () => 42 } })
  // store.meta.set(...) —— 排队写入会在每次运行结束后自动提交
})
```

Hooks：`init` · `clean` · `beforeCompile` · `afterCompile` · `taskError` ——
异步处理器按注册顺序串行执行。`Compiler.use(plugin)` 全局注册插件（对之后
创建的实例生效）；在配置中传入 `plugins` 则只作用于当前实例。默认插件：
`compile-cache`、`dep-graph`、`clean` —— 通过设置 `plugins` 可以替换它们。

### 编译缓存

只要以下任一项变化，缓存文件就会重新编译：工具版本、输出目录是否存在、
配置校验和（不含路径/环境变量/任务/基础设施）、文件 mtime、或其源码引用的
任意 `.env/X` 值。

### 状态存储（SQLite）

状态存放在 `.deltic/state.db`（基于 `better-sqlite3` 的 SQLite）：表包括
`meta`（环境快照、工具版本、配置校验和）、`compiled`（路径 → mtime）、
`checksums`（命名空间 → 路径 → 校验和）、`files`（被追踪的源文件）以及
`nodes`（依赖图边）。插件只修改内存队列；`flush()` 在每次运行结束时把所有
变更放进单个事务提交，`stop()` 时亦然 —— 写入成本是 O(变更量)，永远不是
O(全量状态)。

### 性能剖析

`--profile`（或 `profile: true`）会挂载逐文件/逐管道计时，每次编译后打印
Top-N 表格，并以 `session.profile` 暴露给程序化使用。

### 基准测试

`pnpm bench --files 20000` 端到端编译一条合成的依赖链，并对存储层做微基准
（Windows、NVMe、Node 24 —— 仅供参考）：

| 场景 | 20 000 个文件 |
| --- | --- |
| 冷启动全量构建 | 12.5 s |
| 热构建（全部缓存命中） | **2.8 s** |
| 增量变更，无上游 | **34 ms** |
| 增量变更，追踪到约 10 000 个上游 | 9.9 s |
| 存储层 flush（80 000 行，单事务） | 152 ms |
| 启动加载（compiled + 依赖图） | 25 ms |

基准测试发现并已修复的规模瓶颈：单 JSON 文件存储（已换成 SQLite）、递归的
上游追踪器（深链会栈溢出 —— 已改为迭代式）、以及在管道内部运行的缓存门
（已换成基于 stat 的预过滤器 —— 热运行不再读取文件内容）。

## 配置参考

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `source` / `output` | `src` / `dist` | 相对 `baseDir` 的目录 |
| `cacheDir` | `.deltic` | 状态目录（SQLite 存储） |
| `baseDir` | 配置目录或 cwd | 项目根目录 |
| `alias` | `{}` | 相对 `baseDir` 解析；`http(s)` 值直接透传 |
| `env` | `{}` | 用于替换源码中 `process.env.X` 的值 |
| `loadEnv` | `true` | `.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`；设为 `false` 关闭 |
| `mode` | 按命令为 `development` / `production` | 以 `env.mode` 注入 |
| `ignore` | `[]` | 额外 glob；输出/缓存/node_modules 始终被忽略 |
| `pipes` | — | 实例管道注册表的补充 |
| `plugins` | 默认集合 | 替换默认插件集 |
| `profile` | `false` | `boolean` 或 `{ enabled, topPipes, topFiles }` |
| `progress` | `true` | `[done/total] %` 行式渲染器 |
| `watch` | `{ debounceMs: 200 }` | 另支持透传 chokidar 选项 |
| `logger` / `timer` | 内置实现 | 可注入，便于测试 |

### 别名（alias）语义

别名改写会保留 import 的真实相对深度（`../` 永远不会被剥掉），不匹配任何
别名键的说明符保持原样，同级目录的别名会输出 `./` 前缀的路径 —— 这样依赖
扫描器就能区分别名导入与包导入。

## 路径规则（Windows 与 CI —— 写插件前必读）

deltic 内部对一切路径做了归一化，但路径错误会在插件边界不断放大。以下是
核心所遵循、插件也必须遵循的规则：

1. **glob 模式永远使用正斜杠。** 编写模式时用 `/`；你传入的任何内容
   （`ignore`、任务 `test` 的 glob）deltic 都会归一化。
2. **嵌入模式的字面路径必须用 `escapeGlobLiteral` 转义** —— 否则像
   `job(3) [win]` 这样的 CI 工作区路径会静默匹配不到任何文件。永远不要
   手工拼接 `dir + '/**'`，请使用 `joinGlob(dir, '**/*.js')`。
3. **永远不要用反斜杠转义 glob。** gulp 5 的 glob 引擎运行在
   `windowsPathsNoEscape` 下，`\(` 在那里是字面反斜杠，而 fast-glob 把它
   当作转义 —— 只有字符类形式（`(` → `[(]`、`]` → `[]]`）是两个引擎都
   认可的写法，`escapeGlobLiteral` 输出的正是这种形式。
4. **相对 id 是平台原生的**（`\js\a.js` / `/js/a.js`）—— 由
   `relativeId(path, base)` 生成；不要把
   `path.relative(...).replace(/\\/g,'/')` 当作存储键，也不要跨机器比较 id。
5. **监听器事件是平台原生的**；原样交给 `incrementCompile`/`cleanSpec`
   处理，不要自行转换斜杠。
6. 剥离前缀用 `stripBase(path, base)`（大小写不敏感，保留原大小写）——
   `String.replace(base, '')` 在大小写漂移时会出错，且会替换任意位置的
   首次匹配。

所有辅助函数均从 `'deltic'` 导出（`toGlobPath`、`escapeGlobLiteral`、
`joinGlob`、`stripBase`、`relativeId`）。

## 开发

```bash
pnpm install
pnpm test            # vitest
pnpm test:coverage   # 强制 branches/functions/lines/statements = 100 %
pnpm build           # tsc（TypeScript 7 原生）→ dist/ + d.ts
pnpm typecheck
```

可运行示例见 [example/](./example)。

## 许可证

MIT
