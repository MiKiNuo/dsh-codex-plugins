# dsh-codex-plugins

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中加载 Codex 插件的 **hooks** 和 **插件 MCP**。

它把 Codex 用户 hook 和已安装插件声明的 hooks 合并成一个桥，统一带入当前会话的沙箱策略执行；同时启动 Codex 插件声明的 stdio MCP server。这样不会再把 DSH 安装目录误当成可写工作区。

## 支持范围

- Codex 用户 hook：`~/.codex/hooks.json`
- [context-mode](https://github.com/mksglu/context-mode)：hooks + MCP
- [ponytail](https://github.com/DietrichGebert/ponytail)：hooks
- [i-have-adhd](https://github.com/ayghri/i-have-adhd)：hooks
- [pstack](https://github.com/michael-denyer/pstack-claude)：hooks

插件从 `CODEX_HOME`（默认 `~/.codex`）下的 `plugins/cache/<marketplace>/<plugin>/<version>` 自动选择最新版本。

## 安装

要求：DSH Desktop 0.2.1-rc.2 或更新；Codex 和上述插件已经安装。

```powershell
git clone https://github.com/MiKiNuo/dsh-codex-plugins.git F:\MiKiNuoProjects\dsh-codex-plugins
node F:\MiKiNuoProjects\dsh-codex-plugins\scripts\install.mjs --dsh-home "D:\Program Files\DSH-Desktop\data\dsh-home" --profile web
```

重启 DSH。打开 **设置 → 内置插件 → 全局插件**，搜索 `codex-plugins`。

> 左侧顶部的“插件”是 Agent 插件市场，不会显示这种 host bundle；host 插件在“内置插件”里。

## 配置

安装后的配置在 [codex-plugins.json](./codex-plugins.json)：

```json
{
  "codexHome": "C:/Users/you/.codex",
  "runtimeRoot": "D:/DSH/runtime/dsh/0.2.1-rc.2",
  "suites": [
    { "name": "user", "hooks": "hooks.json" },
    { "name": "context-mode", "marketplace": "context-mode", "plugin": "context-mode", "hooks": ".codex-plugin/hooks.json", "mcp": true }
  ]
}
```

- `codexHome` 省略时使用 `CODEX_HOME` 或 `~/.codex`。
- `runtimeRoot` 省略时自动在 DSH 数据目录的 `runtime/dsh` 中查找带 `dsh-mcp-client` 的最新版本。
- `suites` 中不存在的插件会被跳过并写日志，不会阻塞 DSH 启动。
- 需要更多 Codex 插件时，按同样格式加一项即可。

## 从市场套件切换

如果之前通过 dsh-agent-plugins-market 安装了同名套件，建议关闭它们的 **hooks** 和 **mcp** 表面，保留 skills/agents；否则会出现重复注入或 `serverName already in use`。本插件不依赖市场套件。

## 已知限制

- DSH 的 Claude hook 桥没有 `PreCompact` 事件；Codex 的 `PreCompact` hook 会被跳过。
- Codex 的 tool matcher 会映射到 DSH 的工具名（如 `ops_bash`、`run_code`、`read`），但个别插件脚本仍可能假定 Codex 的原始工具名。
- 这是 host 插件，不是 Agent 套件；它不会出现在左侧“插件”市场页。
- hooks 和 MCP 命令以你的用户权限执行；只安装你信任的 Codex 插件。

## 开发

```bash
npm run check
```

## 许可证

MIT。`vendor/` 中来自 DSH 的 hook 桥和协议代码为 MIT，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
