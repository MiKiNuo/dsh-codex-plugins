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

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function versionKey(value) {
  return String(value).split(/[.+-]/).map(part => (/^\d+$/.test(part) ? part.padStart(9, '0') : part)).join('.');
}
function latestRuntime() {
  const base = process.env.DSH_RUNTIME_ROOT ? path.resolve(process.env.DSH_RUNTIME_ROOT) : process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME, '../runtime/dsh') : path.resolve(pluginRoot, '../../../runtime/dsh');
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))).map(entry => entry.name).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  return versions.length ? path.join(base, versions[0]) : undefined;
}
const token = name => '$' + '{' + name + '}';
function withTimeout(promise, ms, label, logger) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), ms); timer.unref?.(); });
  return Promise.race([Promise.resolve(promise).catch(error => ({ error })), timeout]).then(outcome => {
    clearTimeout(timer);
    if (outcome?.timeout) logger.warn(label + ': still starting after ' + ms + 'ms; continuing in background');
    else if (outcome?.error) logger.error(label + ': ' + String(outcome.error));
    return outcome;
  });
}

// --- Codex config.toml (subset) ---
// Slash/quote-aware split; '#' comments are only recognized by callers.
function splitOutside(text, separator) {
  const parts = [];
  let start = 0, depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}
function balanced(text) {
  let depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth === 0 && quote === null;
}
function parseTomlString(text) {
  const quote = text[0];
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === '\\') {
      const next = text[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return out;
}
function unquoteKey(text) {
  const key = text.trim();
  return key.startsWith('"') || key.startsWith("'") ? parseTomlString(key) : key;
}
function parseTomlValue(text) {
  const value = text.trim();
  if (!value) return '';
  if (value.startsWith('"') || value.startsWith("'")) return parseTomlString(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) return splitOutside(value.slice(1, -1), ',').map(part => part.trim()).filter(Boolean).map(parseTomlValue);
  if (value.startsWith('{') && value.endsWith('}')) {
    const table = {};
    for (const pair of splitOutside(value.slice(1, -1), ',')) {
      if (!pair.trim()) continue;
      const pieces = splitOutside(pair, '=');
      if (pieces.length < 2) continue;
      table[unquoteKey(pieces[0])] = parseTomlValue(pieces.slice(1).join('='));
    }
    return table;
  }
  return value;
}
function readCodexToml(file) {
  const config = { plugins: {}, mcpServers: {} };
  if (!existsSync(file)) return config;
  let table = [];
  let pending = null;
  for (const raw of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (pending) {
      pending.valueText += ' ' + line;
      if (balanced(pending.valueText)) { assignByKey(pending.table, pending.key, pending.valueText); pending = null; }
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) continue;
    const header = /^\[(.+?)\]\s*(?:#.*)?$/.exec(line);
    if (header) { table = splitOutside(header[1], '.').map(unquoteKey); continue; }
    if (!table.length) continue;
    const pieces = splitOutside(line, '=');
    if (pieces.length < 2) continue;
    const key = unquoteKey(pieces[0]);
    const valueText = splitOutside(pieces.slice(1).join('='), '#')[0].trim();
    if ((valueText.startsWith('[') || valueText.startsWith('{')) && !balanced(valueText)) { pending = { table: table.slice(), key, valueText }; continue; }
    assignByKey(table, key, valueText);
  }
  function assignByKey(current, key, valueText) {
    if (!current.length) return;
    let value;
    try { value = parseTomlValue(valueText); } catch { return; }
    if (current[0] === 'plugins' && current[1]) {
      config.plugins[current[1]] = { ...(config.plugins[current[1]] || {}), [key]: value };
      return;
    }
    if (current[0] !== 'mcp_servers' || !current[1]) return;
    const server = config.mcpServers[current[1]] = config.mcpServers[current[1]] || {};
    if (current.length === 2) server[key] = value;
    else if (current[2] === 'env' || current[2] === 'http_headers') (server[current[2]] = server[current[2]] || {})[key] = value;
  }
  return config;
}

// --- Discovery ---
const HOOK_FILES = ['.codex-plugin/hooks.json', 'hooks/codex-hooks.json', 'hooks/hooks.json'];
const MCP_FILES = ['.codex-plugin/mcp.json', 'mcp.json'];
function firstFile(root, candidates) { return candidates.find(rel => existsSync(path.join(root, rel))); }
function pluginManifest(root) {
  for (const rel of ['.codex-plugin/plugin.json', 'plugin.json']) {
    const file = path.join(root, rel);
    if (!existsSync(file)) continue;
    try { return readJson(file); } catch { return {}; }
  }
  return undefined;
}
function discoverSuites(codexHome, codexConfig = { plugins: {}, mcpServers: {} }, options = {}) {
  const suites = [];
  if (existsSync(path.join(codexHome, 'hooks.json'))) suites.push({ name: 'user', root: codexHome, hooks: 'hooks.json' });
  const cache = path.join(codexHome, 'plugins', 'cache');
  if (!existsSync(cache)) return suites;
  const enabledNames = Object.entries(codexConfig.plugins || {}).filter(([, value]) => !value || value.enabled !== false).map(([key]) => key);
  const enabled = enabledNames.length ? new Set(enabledNames) : undefined;
  const seen = new Set(suites.map(suite => suite.name));
  const found = [];
  for (const market of readdirSync(cache, { withFileTypes: true })) {
    if (!market.isDirectory()) continue;
    if (!options.includeBundled && market.name.startsWith('openai-')) continue;
    const marketDir = path.join(cache, market.name);
    let plugins;
    try { plugins = readdirSync(marketDir, { withFileTypes: true }); } catch { continue; }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      let versions;
      try { versions = readdirSync(pluginDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => versionKey(b).localeCompare(versionKey(a))); } catch { continue; }
      const root = versions.map(version => path.join(pluginDir, version)).find(dir => pluginManifest(dir) !== undefined);
      if (!root) continue;
      const manifest = pluginManifest(root) || {};
      const packageName = (manifest.name || plugin.name) + '@' + market.name;
      const directoryName = plugin.name + '@' + market.name;
      if (enabled && !enabled.has(packageName) && !enabled.has(directoryName)) continue;
      const hooks = typeof manifest.hooks === 'string' && existsSync(path.resolve(root, manifest.hooks)) ? manifest.hooks : firstFile(root, HOOK_FILES);
      let mcp;
      if (typeof manifest.mcpServers === 'string' && existsSync(path.resolve(root, manifest.mcpServers))) mcp = manifest.mcpServers;
      else if (manifest.mcpServers && typeof manifest.mcpServers === 'object') mcp = manifest.mcpServers;
      else mcp = firstFile(root, MCP_FILES);
      if (!hooks && !mcp) continue;
      const name = manifest.name || plugin.name;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({ name, root, hooks, mcp });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return [...suites, ...found];
}
function globalMcpConfigs(codexHome, codexConfig = {}, exclude = []) {
  const skip = new Set(exclude || []);
  const configs = [];
  for (const [name, server] of Object.entries(codexConfig.mcpServers || {})) {
    if (!server || server.enabled === false || skip.has(name)) continue;
    if ((server.env_vars || []).includes('CODEX_WINDOWS_REGISTERED_CORE')) continue; // Codex-managed internal runtime
    const env = { ...(server.env || {}) };
    for (const key of server.env_vars || []) if (typeof key === 'string' && process.env[key] !== undefined) env[key] = process.env[key];
    if (typeof server.url === 'string' && server.url) {
      const headers = { ...(server.http_headers || {}) };
      if (typeof server.bearer_token_env_var === 'string' && process.env[server.bearer_token_env_var]) headers.Authorization = 'Bearer ' + process.env[server.bearer_token_env_var];
      configs.push({ transport: 'streamable-http', serverName: name, url: server.url, headers, failOnStartupError: false, toolCallTimeoutMs: 120000, startupTimeoutMs: server.startup_timeout_sec ? server.startup_timeout_sec * 1000 : undefined });
    } else if (typeof server.command === 'string' && server.command) {
      configs.push({
        transport: 'stdio',
        serverName: name,
        command: server.command === 'node' ? process.execPath : server.command,
        args: (server.args || []).map(String),
        cwd: typeof server.cwd === 'string' ? server.cwd : '',
        env: { ...env, CODEX_HOME: codexHome },
        failOnStartupError: false,
        toolCallTimeoutMs: 120000,
        startupTimeoutMs: server.startup_timeout_sec ? server.startup_timeout_sec * 1000 : undefined
      });
    }
  }
  return configs;
}
function existingMcpNames(ctx) {
  const names = new Set();
  try {
    const schemas = ctx.get('tools')?.schemas?.() || [];
    for (const row of schemas) {
      const match = /^mcp__(.+?)__/.exec(row.name || '');
      if (match) names.add(match[1]);
    }
  } catch { /* tools registry not ready yet */ }
  const dshHome = [process.env.DSH_HOME, path.resolve(pluginRoot, '../..')].find(dir => dir && existsSync(path.join(dir, 'storages', 'mcp_connector.json')));
  if (dshHome) {
    const file = path.join(dshHome, 'storages', 'mcp_connector.json');
    try {
      const connections = readJson(file).tables?.connections || {};
      for (const connection of Object.values(connections)) {
        if (connection && connection.enabled !== false && connection.serverName) names.add(connection.serverName);
      }
    } catch { /* optional DSH store */ }
  }
  return names;
}

// --- Codex hook normalization ---
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
function latestRoot(codexHome, marketplace, plugin) {
  const base = path.join(codexHome, 'plugins', 'cache', marketplace, plugin);
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && pluginManifest(path.join(base, entry.name)) !== undefined)
    .map(entry => entry.name)
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  return versions.length ? path.join(base, versions[0]) : undefined;
}
function resolveSuite(spec, codexHome, optional = false) {
  const root = spec.root ? path.resolve(spec.root) : spec.marketplace ? latestRoot(codexHome, spec.marketplace, spec.plugin) : codexHome;
  if (!root || !existsSync(root)) throw new Error('codex-plugins: suite root not found for ' + spec.name);
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
  const hooksRel = typeof spec.hooks === 'string' ? spec.hooks : typeof manifest.hooks === 'string' ? manifest.hooks : undefined;
  const hooksPath = hooksRel ? path.resolve(root, hooksRel) : undefined;
  let events = {};
  if (hooksPath && existsSync(hooksPath)) {
    const normalized = normalizeHooks(readJson(hooksPath), root);
    normalized.root = root;
    writeJson(path.join(generatedRoot, spec.name + '.json'), normalized);
    events = normalized.hooks;
  } else if (!optional) {
    throw new Error('codex-plugins: hooks not found for ' + spec.name + ': ' + (hooksPath || root));
  }
  let mcp;
  const declared = spec.mcp === true ? manifest.mcpServers : spec.mcp !== undefined ? spec.mcp : manifest.mcpServers;
  if (declared && typeof declared === 'object') {
    const file = path.join(generatedRoot, spec.name + '-mcp.json');
    writeJson(file, { mcpServers: declared });
    mcp = file;
  } else if (declared === true) {
    mcp = path.resolve(root, 'mcp.json');
  } else if (typeof declared === 'string') {
    mcp = path.resolve(root, declared);
  }
  if (mcp && !existsSync(mcp)) mcp = undefined;
  return { name: spec.name, root, events, mcp };
}
function mcpConfigs(suite, codexHome) {
  if (!suite.mcp || !existsSync(suite.mcp)) return [];
  const raw = readJson(suite.mcp);
  const out = [];
  for (const [name, server] of Object.entries(raw.mcpServers || {})) {
    if (!server || server.enabled === false) continue;
    const env = { ...(server.env || {}), CODEX_HOME: codexHome, CONTEXT_MODE_PLATFORM: 'codex' };
    for (const key of server.env_vars || []) if (typeof key === 'string' && process.env[key] !== undefined) env[key] = process.env[key];
    if (typeof server.url === 'string' && server.url) {
      out.push({ transport: 'streamable-http', serverName: name, url: server.url, headers: { ...(server.http_headers || {}) }, failOnStartupError: false, toolCallTimeoutMs: 120000, startupTimeoutMs: server.startup_timeout_sec ? server.startup_timeout_sec * 1000 : undefined });
      continue;
    }
    if (typeof server.command !== 'string') continue;
    out.push({
      transport: 'stdio',
      serverName: name,
      command: server.command === 'node' ? process.execPath : server.command,
      args: (server.args || []).map(arg => arg.startsWith('./') ? path.join(suite.root, arg) : arg),
      cwd: path.resolve(suite.root, server.cwd || '.'),
      env,
      failOnStartupError: false,
      toolCallTimeoutMs: 120000,
      startupTimeoutMs: server.startup_timeout_sec ? server.startup_timeout_sec * 1000 : undefined
    });
  }
  return out;
}

export const name = 'codex-plugins';
export const inject = [];

export async function apply(ctx, config = {}) {
  const configPath = config.configPath ? path.resolve(config.configPath) : defaultConfig;
  const settings = existsSync(configPath) ? readJson(configPath) : {};
  const codexHome = path.resolve(settings.codexHome || codexHomeDefault);
  const codexConfig = readCodexToml(path.join(codexHome, 'config.toml'));
  const specs = [...(settings.suites || [])];
  if (settings.autoDiscover !== false) {
    for (const suite of discoverSuites(codexHome, codexConfig, { includeBundled: settings.includeBundledPlugins === true })) {
      if (!specs.some(spec => spec.name === suite.name)) specs.push(suite);
    }
  }
  const suites = [];
  for (const spec of specs) {
    try { suites.push(resolveSuite(spec, codexHome, !spec.marketplace)); }
    catch (error) { ctx.logger.warn('codex-plugins: skipping ' + spec.name + ': ' + String(error)); }
  }
  const merged = { hooks: {} };
  for (const suite of suites) {
    for (const [event, groups] of Object.entries(suite.events || {})) {
      merged.hooks[event] = [...(merged.hooks[event] || []), ...groups];
    }
  }
  if (Object.keys(merged.hooks).length) {
    const bridge = await import(pathToFileURL(bridgePath).href);
    const mergedPath = path.join(generatedRoot, 'merged.json');
    writeJson(mergedPath, merged);
    const bridgePlugin = { name: 'codex-hooks', apply: (child, cfg) => bridge.apply(child, cfg), inject: bridge.inject, Config: bridge.Config };
    try { await ctx.plugin(bridgePlugin, { configPath: mergedPath, pluginRoot: codexHome }); }
    catch (error) { ctx.logger.error('codex-plugins: merged hooks failed: ' + String(error)); }
  }
  let mcp;
  const runtimeRoot = settings.runtimeRoot ? path.resolve(settings.runtimeRoot) : latestRuntime();
  const mcpPath = runtimeRoot ? path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js') : undefined;
  try { mcp = await import('@deepseek-ai/dsh-mcp-client'); }
  catch { if (!mcpPath || !existsSync(mcpPath)) throw new Error('codex-plugins: dsh-mcp-client not found; set runtimeRoot in ' + configPath); mcp = await import(pathToFileURL(mcpPath).href); }
  const existing = settings.skipExistingMcp === false ? new Set() : existingMcpNames(ctx);
  const servers = [];
  const add = (serverConfig) => {
    if (!serverConfig) return;
    if (existing.has(serverConfig.serverName)) {
      ctx.logger.info('codex-plugins: skipping MCP ' + serverConfig.serverName + ' (already provided by DSH)');
      return;
    }
    existing.add(serverConfig.serverName);
    servers.push(serverConfig);
  };
  for (const suite of suites) for (const serverConfig of mcpConfigs(suite, codexHome)) add(serverConfig);
  if (settings.includeGlobalMcp !== false) for (const serverConfig of globalMcpConfigs(codexHome, codexConfig, settings.mcpExclude)) add(serverConfig);
  const startupTimeout = Number(settings.mcpStartupTimeoutMs) || 15000;
  let mcpCount = 0;
  for (const serverConfig of servers) {
    const started = await withTimeout(ctx.plugin({ name: 'codex-mcp:' + serverConfig.serverName, apply: (child, cfg) => mcp.apply(child, cfg), inject: mcp.inject, Config: mcp.Config }, serverConfig), serverConfig.startupTimeoutMs || startupTimeout, 'codex-plugins: MCP ' + serverConfig.serverName, ctx.logger);
    if (!started?.timeout && !started?.error) mcpCount++;
  }
  ctx.logger.info('codex-plugins: loaded ' + suites.length + ' hook suites and ' + mcpCount + ' MCP server(s)');
}

export { readCodexToml, discoverSuites, globalMcpConfigs };
