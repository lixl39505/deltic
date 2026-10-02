# MAINTENANCE（维护手册）

面向维护者的笔记：工具链基线、质量门禁、架构规则、发布清单。用户侧文档见
[README.md](./README.zh-CN.md)；可运行示例在 [example/](./example)。

## 工具链基线

| 方面 | 选择 |
| --- | --- |
| 运行时 | Node >= 20 |
| 包管理器 | pnpm（workspace 根，`pnpm-workspace.yaml`） |
| 语言 | TypeScript 7，使用原生 `tsc` 编译 —— **不用打包器**：`tsc -p tsconfig.build.json` → `dist/` + d.ts |
| 模块系统 | 仅 ESM（`"type": "module"`） |
| 流式处理 | gulp 5 + streamx + vinyl 3 |
| 状态存储 | better-sqlite3 → `.deltic/state.db`（SQLite） |
| 测试 | vitest + `@vitest/coverage-istanbul` |

better-sqlite3 自带 prebuilds —— 永远不要启用它的 install 脚本（那条路径
需要 Python 工具链）。发布的产物只有 `dist/` + `bin/`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `pnpm test` | vitest 运行 |
| `pnpm test:coverage` | 带覆盖率且强制 100 % 阈值 |
| `pnpm test:e2e` | 构建 + 端到端套件（`test/e2e`） |
| `pnpm typecheck` | 对整个项目执行 `tsc --noEmit` |
| `pnpm build` / `pnpm dev` | 生产构建 / 监听构建 |
| `pnpm bench --files 20000` | 合成端到端 + 存储层微基准 |
| `pnpm format` | prettier |

## 质量门禁

- **强制 100 % 覆盖率**（分支 / 函数 / 行 / 语句，见 `vitest.config.ts`）。
  新代码要么附带穷尽式测试，要么不合并；放宽阈值必须在 PR 中给出明确理由。
- `pnpm typecheck` 必须零错误；公共 API 变更必须保证生成的 `dist/*.d.ts`
  保持一致。
- 错误模型：面向用户的失败抛出 `ConfigError` / `CompileError` /
  `CapabilityMissingError`，并附可读信息。装配类问题（未知管道、缺失插件
  能力）必须在装配/启动期失败，绝不能拖到编译中途。
- 状态写入在内存中排队，每次运行以单个事务提交（`flush()` / `stop()`）——
  新增的状态访问必须保持 O(变更量)，绝不能 O(全量)。

## 架构规则

- **组合优于继承。** 通过插件、管道和 hooks 扩展；公共接口不暴露任何子类化
  钩子。
- **能力应下沉到 deltic，而不是让下游各自堆 workaround。** 当消费方需要
  通用行为时，在这里增加原生选项/工厂 —— 例如提供 `createConfigLoader`，
  就是为了让下游包能加载自己的配置文件（不同文件名、自别名），而不是复制
  `loadConfig`。
- **一切显式。** `tasks` 未声明的任务不存在；没有隐式的插件或管道注册。
- **细粒度缓存失效。** 校验和按任务/文件作用域绑定；兜底失效走 `extraDeps`
  并做逐项浅比较 —— 绝不做粗粒度的全局版本号递增。
- **路径处理**：遵循 README 的「路径规则」—— 使用 `toGlobPath`、
  `escapeGlobLiteral`、`joinGlob`、`stripBase`、`relativeId`；永远不要
  手写斜杠转换或 glob 转义。
- 提交信息遵循 `.agents/skills/git-commit-message/SKILL.md` 定义的中文
  Conventional Commits 格式。

## 发布清单

1. `pnpm install && pnpm typecheck && pnpm test:coverage`
2. `pnpm build && pnpm test:e2e`
3. `pnpm bench --files 20000` —— 与 README 的基准表对比。热构建和小步增量
   是用户真正能感知的数字；即使测试全绿，这里出现回归也是 bug。发布前先
   查清原因。
4. 升版本号并 `pnpm publish`；用 `npm pack --dry-run` 验证 tarball 只含
   `dist/` + `bin/`。
5. 状态兼容性：0.x 阶段，磁盘上的 `.deltic/state.db` 不提供迁移保证。如果
   某次发布改动了 SQLite schema 或校验和命名空间，请在发布说明中注明
   （「删除 `.deltic/` 并重新构建」）。
