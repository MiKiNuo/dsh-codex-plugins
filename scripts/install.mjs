import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const dshHome = opt('--dsh-home') || process.env.DSH_HOME;
const profile = opt('--profile') || 'web';
if (!dshHome) {
  console.error('usage: node scripts/install.mjs --dsh-home <DSH_HOME> [--profile web]');
  process.exit(2);
}
const profileDir = path.join(path.resolve(dshHome), 'profiles', profile);
const manifest = path.join(profileDir, 'package.json');
if (!fs.existsSync(manifest)) { console.error('profile not found: ' + profileDir); process.exit(2); }
const link = path.join(profileDir, 'node_modules', 'dsh-codex-plugins');
fs.mkdirSync(path.dirname(link), { recursive: true });
const existing = fs.lstatSync(link, { throwIfNoEntry: false });
if (existing?.isSymbolicLink()) fs.unlinkSync(link);
else if (existing) fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir');
const runtime = opt('--runtime') || path.resolve(path.resolve(dshHome), '../runtime/dsh');
let runtimeRoot = runtime;
try {
  const versions = fs.readdirSync(runtime, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
  const found = versions.find(v => fs.existsSync(path.join(runtime, v, 'node_modules', '@deepseek-ai', 'dsh-llm')));
  if (found) runtimeRoot = path.join(runtime, found);
} catch {}
for (const name of ['dsh-llm', 'schemastery']) {
  const from = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', name);
  const to = path.join(project, 'node_modules', '@deepseek-ai', name);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.lstatSync(to, { throwIfNoEntry: false })) fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
}
const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
data.dsh = data.dsh || {};
data.dsh.profile = data.dsh.profile || {};
data.dsh.profile.bundles = data.dsh.profile.bundles || [];
if (!data.dsh.profile.bundles.includes('dsh-codex-plugins')) data.dsh.profile.bundles.push('dsh-codex-plugins');
fs.writeFileSync(manifest, JSON.stringify(data, null, 2) + '\n');
console.log('installed ' + project);
console.log('  link: ' + link);
console.log('  profile bundle: dsh-codex-plugins');
console.log('Restart DSH, then open Settings -> Built-in plugins -> Global plugins and search "codex-plugins".');