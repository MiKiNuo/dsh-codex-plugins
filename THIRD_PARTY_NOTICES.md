# Third-party notices

## @deepseek-ai/dsh-hooks-claude-code

- Version: 0.2.1-rc.2
- License: MIT
- Source: https://github.com/deepseek-ai/deepseek-harness
- Local modification: pass the owning session sandboxPolicy to runHook, and expose CLAUDE_PLUGIN_ROOT, PLUGIN_ROOT, CODEX_PLUGIN_ROOT, and PLUGIN_DATA to hook processes.

## @deepseek-ai/dsh-hook-protocol

- Version: 0.2.1-rc.2
- License: MIT
- Source: https://github.com/deepseek-ai/deepseek-harness
- Local modification: forward an explicit sandboxPolicy from the runner request to the shell executor.

The vendored files are included to keep the plugin self-contained. They remain under their original MIT license.
