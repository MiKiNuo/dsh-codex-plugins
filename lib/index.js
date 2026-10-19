import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const defaultConfig = path.join(pluginRoot, 'codex-plugins.json');
const generatedRoot = path.join(pluginRoot, 'generated');
const codexHomeDefault = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const bridgePath = process.env.DSH_CODEX_HOOKS_BRIDGE || path.join(pluginRoot, 'vendor', 'dsh-hooks-claude-code', 'lib', 'index.js');
function latestRuntime() {
  const base = process.env.DSH_RUNTIME_ROOT ? path.resolve(process.env.DSH_RUNTIME_ROOT) : process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME, '../runtime/dsh') : path.resolve(pluginRoot, '../../../runtime/dsh');
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))).map(entry => entry.name).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  return versions.length ? path.join(base, versions[0]) : undefined;
}
const token = name => '$' + '{' + name + '}';

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function versionKey(value) {
  return String(value).split(/[.+-]/).map(part => (/^\d+$/.test(part) ? part.padStart(9, '0') : part)).join('.');
}
function latestRoot(codexHome, marketplace, plugin) {
  const base = path.join(codexHome, 'plugins', 'cache', marketplace, plugin);
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(base, entry.name, '.codex-plugin', 'plugin.json')))
    .map(entry => entry.name)
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  return versions.length ? path.join(base, versions[0]) : undefined;
}
const TOOL_PATTERN_REPLACEMENTS = [
  ['local_shell|shell|shell_command|exec_command|Bash|Shell', 'ops_bash|run_code|pwsh'],
  ['apply_patch|Edit|Write', 'write|edit'],
  ['grep_files', 'grep|glob'],
  ['ctx_execute_file', 'mcp__context-mode__ctx_execute_file'],
  ['ctx_batch_execute', 'mcp__context-mode__ctx_batch_execute'],
  ['ctx_fetch_and_index', 'mcp__context-mode__ctx_fetch_and_index'],
  ['ctx_execute', 'mcp__context-mode__ctx_execute'],
  ['ctx_search', 'mcp__context-mode__ctx_search'],
  ['ctx_index', 'mcp__context-mode__ctx_index']
];
function mapToolMatcher(matcher) {
  if (!matcher || matcher === '*' || matcher === '.*') return matcher;
  let out = matcher;
  for (const [from, to] of TOOL_PATTERN_REPLACEMENTS) out = out.split(from).join(to);
  if (!out.includes('ops_bash')) out += '|ops_bash|run_code|pwsh|read|write|edit|grep|glob|mcp__';
  return out;
}
function normalizeHooks(raw, root) {
  const source = raw && typeof raw.hooks === 'object' && raw.hooks !== null ? raw.hooks : raw;
  const events = {};
  const normalizedRoot = root.replace(/\\/g, '/');
  for (const [event, groups] of Object.entries(source || {})) {
    if (event === 'PreCompact') continue;
    if (!Array.isArray(groups)) continue;
    events[event] = groups.map(group => ({
      ...(typeof group.matcher === 'string' ? { matcher: event === 'PreToolUse' || event === 'PostToolUse' ? mapToolMatcher(group.matcher) : group.matcher } : {}),
      hooks: (Array.isArray(group.hooks) ? group.hooks : []).map(hook => {
        const command = process.platform === 'win32' && typeof hook.commandWindows === 'string' ? hook.commandWindows : hook.command;
        if (typeof command !== 'string') return hook;
        return {
          ...hook,
          command: command
            .split(token('PLUGIN_ROOT')).join(normalizedRoot)
            .split(token('CLAUDE_PLUGIN_ROOT')).join(normalizedRoot)
            .split(token('CODEX_PLUGIN_ROOT')).join(normalizedRoot)
            .split('process.env.CLAUDE_PLUGIN_ROOT').join("'" + normalizedRoot + "'")
        };
      })
    }));
  }
  return { hooks: events };
}
function resolveSuite(spec, codexHome) {
  const root = spec.name === 'user' ? codexHome : spec.root ? path.resolve(spec.root) : latestRoot(codexHome, spec.marketplace, spec.plugin);
  if (!root || !existsSync(root)) throw new Error('codex-plugins: suite root not found for ' + spec.name);
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
  const hooksRel = spec.hooks || manifest.hooks || 'hooks/hooks.json';
  const hooksPath = path.resolve(root, hooksRel);
  if (!existsSync(hooksPath)) throw new Error('codex-plugins: hooks not found for ' + spec.name + ': ' + hooksPath);
  const normalized = normalizeHooks(readJson(hooksPath), root);
  normalized.root = root;
  const generated = path.join(generatedRoot, spec.name + '.json');
  writeJson(generated, normalized);
  const mcpRel = spec.mcp ? (spec.mcp === true ? manifest.mcpServers : spec.mcp) : undefined;
  return { name: spec.name, root, generated, events: normalized.hooks, mcp: mcpRel ? path.resolve(root, mcpRel) : undefined };
}
function mcpConfigs(suite, codexHome) {
  if (!suite.mcp || !existsSync(suite.mcp)) return [];
  const raw = readJson(suite.mcp);
  const out = [];
  for (const [name, server] of Object.entries(raw.mcpServers || {})) {
    if (!server || typeof server.command !== 'string') continue;
    out.push({
      transport: 'stdio',
      serverName: name,
      command: server.command === 'node' ? process.execPath : server.command,
      args: (server.args || []).map(arg => arg.startsWith('./') ? path.join(suite.root, arg) : arg),
      cwd: path.resolve(suite.root, server.cwd || '.'),
      env: { ...(server.env || {}), CODEX_HOME: codexHome, CONTEXT_MODE_PLATFORM: 'codex' },
      failOnStartupError: false,
      toolCallTimeoutMs: 120000
    });
  }
  return out;
}

export const name = 'codex-plugins';
export const inject = [];

export async function apply(ctx, config = {}) {
  const configPath = config.configPath ? path.resolve(config.configPath) : defaultConfig;
  const settings = existsSync(configPath) ? readJson(configPath) : { codexHome: codexHomeDefault, suites: [] };
  const codexHome = path.resolve(settings.codexHome || codexHomeDefault);
  const suites = [];
  for (const spec of settings.suites || []) {
    try { suites.push(resolveSuite(spec, codexHome)); }
    catch (error) { ctx.logger.warn('codex-plugins: skipping ' + spec.name + ': ' + String(error)); }
  }
  const bridge = await import(pathToFileURL(bridgePath).href);
  let mcp;
  const runtimeRoot = settings.runtimeRoot ? path.resolve(settings.runtimeRoot) : latestRuntime();
  const mcpPath = runtimeRoot ? path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js') : undefined;
  try { mcp = await import('@deepseek-ai/dsh-mcp-client'); }
  catch { if (!mcpPath || !existsSync(mcpPath)) throw new Error('codex-plugins: dsh-mcp-client not found; set runtimeRoot in ' + configPath); mcp = await import(pathToFileURL(mcpPath).href); }
  const merged = { hooks: {} };
  for (const suite of suites) {
    for (const [event, groups] of Object.entries(suite.events || {})) {
      merged.hooks[event] = [...(merged.hooks[event] || []), ...groups];
    }
  }
  const mergedPath = path.join(generatedRoot, 'merged.json');
  writeJson(mergedPath, merged);
  const bridgePlugin = { name: 'codex-hooks', apply: (child, cfg) => bridge.apply(child, cfg), inject: bridge.inject, Config: bridge.Config };
  try { await ctx.plugin(bridgePlugin, { configPath: mergedPath, pluginRoot: codexHome }); }
  catch (error) { ctx.logger.error('codex-plugins: merged hooks failed: ' + String(error)); }
  let mcpCount = 0;
  for (const suite of suites) {
    for (const mcpConfig of mcpConfigs(suite, codexHome)) {
      try { await ctx.plugin({ name: 'codex-mcp:' + mcpConfig.serverName, apply: (child, cfg) => mcp.apply(child, cfg), inject: mcp.inject, Config: mcp.Config }, mcpConfig); mcpCount++; }
      catch (error) { ctx.logger.error('codex-plugins: MCP ' + mcpConfig.serverName + ' failed: ' + String(error)); }
    }
  }
  ctx.logger.info('codex-plugins: loaded ' + suites.length + ' hook suites and ' + mcpCount + ' MCP server(s)');
}