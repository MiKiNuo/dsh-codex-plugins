# dsh-codex-plugins

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中加载 Codex 的 **hooks** 和 **MCP server**。不用在配置里逐个列插件：它读取 Codex 自己的配置，自动发现你已启用的插件和 MCP。

它把 Codex 用户 hook 和各插件声明的 hooks 合并成一个桥，统一带入当前会话的沙箱策略执行；同时按声明启动 stdio / streamable-http MCP server。这样不会再把 DSH 安装目录误当成可写工作区。

## 自动发现

每次 DSH 启动时，插件从 `CODEX_HOME`（默认 `~/.codex`）读取：

- `hooks.json`：Codex 用户 hook。
- `config.toml` 的 `[plugins."name@marketplace"]`：只加载 `enabled = true` 的插件。
- `config.toml` 的 `[mcp_servers.*]`：全局 MCP server（stdio 和 streamable-http）。
- `plugins/cache/<marketplace>/<plugin>/<version>`：每个已启用插件的最新版本，从其 `.codex-plugin/plugin.json` 读取 `hooks` 和 `mcpServers` 声明。
  - 默认跳过 `openai-*` 内置 marketplace（Codex 自带工具）；需要时用 `includeBundledPlugins` 打开。
  - 跳过带 `CODEX_WINDOWS_REGISTERED_CORE` 的 Codex 自管 REPL（如 `node_repl`）。
  - 没有声明时回退到 `.codex-plugin/hooks.json`、`hooks/codex-hooks.json`、`hooks/hooks.json` 和 `.codex-plugin/mcp.json`、`mcp.json`。
  - MCP 条目 `enabled = false` 的会跳过。
- `env_vars` 会把同名环境变量传入 MCP 进程；`bearer_token_env_var` 会转成 `Authorization: Bearer`。

已经在 DSH 里存在的 MCP server（工具名前缀 `mcp__<name>__` 或 DSH 连接器里已启用）会被跳过，避免重名。

## 支持范围

自动发现适用于 Codex 的插件缓存格式，已实测：

- [context-mode](https://github.com/mksglu/context-mode)：hooks + MCP
- [ponytail](https://github.com/DietrichGebert/ponytail)：hooks
- [i-have-adhd](https://github.com/ayghri/i-have-adhd)：hooks
- [pstack](https://github.com/michael-denyer/pstack-claude)：hooks

任何使用 `.codex-plugin/plugin.json` 声明 hooks/MCP 的插件都应可用。

## 安装

要求：DSH Desktop 0.2.1-rc.2 或更新；Codex 已安装，且至少有一个 Codex 插件或 MCP server。

```powershell
git clone https://github.com/MiKiNuo/dsh-codex-plugins.git F:\MiKiNuoProjects\dsh-codex-plugins
node F:\MiKiNuoProjects\dsh-codex-plugins\scripts\install.mjs --dsh-home "D:\Program Files\DSH-Desktop\data\dsh-home" --profile web
```

重启 DSH。打开 **设置 → 内置插件 → 全局插件**，搜索 `codex-plugins`。

> 左侧顶部的“插件”是 Agent 插件市场，不会显示这种 host bundle；host 插件在“内置插件”里。

## 安装失败：ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED

DSH 用 pnpm 安装 profile 依赖时，会拦截 git 来源包的构建脚本。`dsh-ops` 是 DSH 自己的依赖，需要在失败的那个 profile 里放行一次。

编辑 `<DSH_HOME>/profiles/web/pnpm-workspace.yaml`（Windows 默认在 `D:\Program Files\DSH-Desktop\data\dsh-home\profiles\web\pnpm-workspace.yaml`）：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

onlyBuiltDependencies:
  - dsh-ops
```

然后重试安装。

如果 pnpm 仍报同一错误，把条目换成报错信息给出的完整标识（commit 以实际报错为准）：

```yaml
onlyBuiltDependencies:
  - "dsh-ops@https://codeload.github.com/T-Auto/dsh-ops/tar.gz/a9ff940319b5bda0e8bf805badf7844a1e69cef8"
```

只放行 `dsh-ops` 即可；不要改成 `dangerouslyAllowAllBuilds`。

本插件本身不依赖 pnpm：`scripts/install.mjs` 只建 junction 和 profile bundle。但 DSH 在依赖变化时仍会跑 pnpm，所以上面的放行依然需要。

## 配置

默认配置 [codex-plugins.json](./codex-plugins.json) 只需要打开自动发现：

```json
{
  "autoDiscover": true,
  "includeGlobalMcp": true
}
```

可选项：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `codexHome` | `CODEX_HOME` 或 `~/.codex` | Codex 数据目录 |
| `runtimeRoot` | 自动查找 | 带 `dsh-mcp-client` 的 DSH runtime 版本目录 |
| `autoDiscover` | `true` | 关掉后只加载 `suites` |
| `includeGlobalMcp` | `true` | 是否加载 `config.toml` 的 `[mcp_servers.*]` |
| `includeBundledPlugins` | `false` | 是否加载 `openai-*` marketplace 的内置插件 |
| `mcpExclude` | `[]` | 不加载的 MCP server 名，例如 `["node_repl"]` |
| `mcpStartupTimeoutMs` | `15000` | 单个 MCP server 的连接等待上限，超时后继续启动 DSH |
| `skipExistingMcp` | `true` | 跳过 DSH 里已有的同名 MCP server |
| `suites` | `[]` | 手动指定插件，优先于自动发现；同名项会覆盖自动结果 |

手动指定示例（一般不需要）：

```json
{
  "suites": [
    { "name": "user", "hooks": "hooks.json" },
    { "name": "context-mode", "marketplace": "context-mode", "plugin": "context-mode", "hooks": ".codex-plugin/hooks.json", "mcp": true }
  ]
}
```

## 从市场套件切换

如果之前通过 dsh-agent-plugins-market 安装了同名套件，建议关闭它们的 **hooks** 和 **mcp** 表面，保留 skills/agents；否则会出现重复注入或 `serverName already in use`。本插件不依赖市场套件。

## 已知限制

- DSH 没有 `PreCompact` 扩展点；Codex 的 `PreCompact` hook 会被跳过，其余 Codex hook 事件都会执行。
- 钩子的纯文本 stdout 在 `SessionStart` 和 `UserPromptSubmit` 会作为上下文注入（pstack、ponytail 依赖这个行为）；其它事件的纯文本只记录，不注入。
- 同一个 session 在首个 turn 之前被重复创建时，相同的 SessionStart 上下文只注入一次。
- Codex 的 tool matcher 会映射到 DSH 的工具名（如 `ops_bash`、`run_code`、`read`），但个别插件脚本仍可能假定 Codex 的原始工具名。
- MCP 的 `enabled_tools` / `omit_tools_from` 工具过滤没有实现，因为 `dsh-mcp-client` 不支持。
- `config.toml` 只解析插件/MCP 需要的子集：表头、字符串、布尔、数字、单行数组和行内表。多行数组会被跳过。
- Codex 自管的服务（如 `node_repl`）按环境标记跳过；单独需要时用 `suites` 手动加回。
- `includeBundledPlugins` 打开后，Codex 内置插件的 MCP 如果带 `enabled = true` 也会被加载。
- 这是 host 插件，不是 Agent 套件；它不会出现在左侧“插件”市场页。
- hooks 和 MCP 命令以你的用户权限执行；只安装你信任的 Codex 插件。

## 开发

```bash
npm run check
npm test
```

## 许可证

MIT。`vendor/` 中来自 DSH 的 hook 桥和协议代码为 MIT，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
