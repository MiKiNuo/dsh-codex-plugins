import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSuites, globalMcpConfigs, readCodexToml } from '../lib/index.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'codex-plugins-test-'));
const codexHome = path.join(root, '.codex');
function write(rel, text) {
  const file = path.join(codexHome, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

write('hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node user.js' }] }] } }));
write('config.toml', [
  'model = "x"',
  '[plugins."demo@demo-market"]',
  'enabled = true',
  '[plugins."off@demo-market"]',
  'enabled = false',
  '[plugins."bundled@openai-bundled"]',
  'enabled = true',
  '[features]',
  'list = [',
  '  "a",',
  '  "b"',
  ']',
  '[mcp_servers.global]',
  'command = "node"',
  'args = ["./server.js"]',
  'env = { "A" = "1" }',
  'env_vars = ["HOME_PATH"]',
  '[mcp_servers.remote]',
  'url = "https://example.test/mcp"',
  'bearer_token_env_var = "DEMO_TOKEN"',
  '[mcp_servers.after]',
  'command = "after-bin"',
  '[mcp_servers.internal]',
  'command = "internal-bin"',
  'env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]'
].join('\n') + '\n');
write('plugins/cache/demo-market/demo/1.0.0/.codex-plugin/plugin.json', JSON.stringify({ name: 'demo', hooks: './.codex-plugin/hooks.json', mcpServers: './.codex-plugin/mcp.json' }));
write('plugins/cache/demo-market/demo/1.0.0/.codex-plugin/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/start.js"' }] }] } }));
write('plugins/cache/demo-market/demo/1.0.0/.codex-plugin/mcp.json', JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['./start.mjs'] } } }));
write('plugins/cache/demo-market/off/2.0.0/.codex-plugin/plugin.json', JSON.stringify({ name: 'off' }));
write('plugins/cache/demo-market/off/2.0.0/hooks/hooks.json', JSON.stringify({ hooks: {} }));
write('plugins/cache/openai-bundled/bundled/1.0.0/.codex-plugin/plugin.json', JSON.stringify({ name: 'bundled' }));
write('plugins/cache/openai-bundled/bundled/1.0.0/hooks/hooks.json', JSON.stringify({ hooks: {} }));

process.env.HOME_PATH = '/tmp/home';
process.env.DEMO_TOKEN = 'secret';

const config = readCodexToml(path.join(codexHome, 'config.toml'));
assert.deepEqual(config.plugins, { 'demo@demo-market': { enabled: true }, 'off@demo-market': { enabled: false }, 'bundled@openai-bundled': { enabled: true } });
assert.equal(config.mcpServers.global.env.A, '1');
assert.deepEqual(config.mcpServers.global.args, ['./server.js']);
assert.equal(config.mcpServers.remote.url, 'https://example.test/mcp');
assert.equal(config.mcpServers.after.command, 'after-bin');
assert.equal(config.plugins.demo, undefined);

const suites = discoverSuites(codexHome, config);
assert.deepEqual(suites.map(suite => suite.name), ['user', 'demo']);
assert.equal(discoverSuites(codexHome, config, { includeBundled: true }).some(suite => suite.name === 'bundled'), true);
assert.equal(suites[1].hooks, './.codex-plugin/hooks.json');

const servers = globalMcpConfigs(codexHome, config);
assert.deepEqual(servers.map(server => server.serverName), ['global', 'remote', 'after']);
assert.equal(servers.some(server => server.serverName === 'internal'), false);
assert.equal(servers[0].command, process.execPath);
assert.equal(servers[0].env.A, '1');
assert.equal(servers[0].env.HOME_PATH, '/tmp/home');
assert.equal(servers[1].transport, 'streamable-http');
assert.equal(servers[1].headers.Authorization, 'Bearer secret');

rmSync(root, { recursive: true, force: true });
console.log('discovery test ok');
