// Registration for both harnesses, plus a health check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, renameSync, openSync, closeSync, fsyncSync, statSync, realpathSync, accessSync, constants } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { resolveBin, runCli, BridgeError, BINS_FILE } from './exec.mjs';
import { listClaudeSessions, listCodexThreads, findAppTools } from './transport.mjs';
import { MAX_TIMEOUT_MS } from './peer.mjs';
import { readChain, writeChain } from './usage.mjs';
import { magiHome as magiHomeDir } from './state.mjs';
import { redact } from './protocol.mjs';
import { claudeDialogTimeoutInfo, readClaudeDialogSettings } from './claude-dialog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'magi.mjs');

// The Claude inbox frame and the Codex desktop steer channel are private
// formats, verified by hand at these versions (docs/transport-recon.md). A
// newer CLI can change either without any error: live delivery then quietly
// falls back to headless and only the reply footer says so.
// omp: the extension events (agent_start/agent_end) and registry contract.
// claudeApp / codexApp: the desktop apps' URL routes `magi spawn --app`
// opens sessions with (claude://code/new, codex://threads/new) and the
// registry's `entrypoint: "claude-desktop"`; read from the app bundles and
// checked live 2026-09-16. codex 0.155.1 / codexApp 26.915.4065.0 re-checked
// 2026-09-22: live queue delivery and reply, live steer, and the
// threads/new route with its path and prompt params read from the bundle.
// codex 0.160.1 with desktop 26.930.7945.0, 2026-10-08: the state_5.sqlite
// `threads` and thread_history_1.sqlite columns `magi status` reads, and
// thread-writer-locks; codexApp stays at the version its routes were checked on.
// claude 2.1.310, 2026-10-29: the inbox frame, envelope, gate, registry fields and
// transcript origin read in its bundle, and the headless stream-json channel run
// live; a live delivery into a running session was not re-run (docs/transport-recon.md).
export const VERIFIED_VERSIONS = { claude: '2.1.310', codex: '0.160.1', omp: '18.4.4', claudeApp: '2.110.0.0', codexApp: '26.915.4065.0' };

// The desktop apps, two facts each: the installed version where the OS
// records one, and whether a handler for the app's URL scheme is
// registered. Neither being seen is a note, not proof of absence: a
// per-machine install can register elsewhere. Windows only; other
// platforms report nothing here. ponytail: `open` / `xdg-open` never
// report, so a missing handler there shows up as SPAWN_FAILED at spawn.
export function desktopApps() {
  if (platform() !== 'win32') return [];
  const reg = (key, ...args) => {
    try {
      return execFileSync('reg', ['query', key, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
    } catch {
      return '';
    }
  };
  // Both apps are Store packages: the scheme is a class with a "URL Protocol"
  // value and no command of its own (the package handles it; the
  // shell\open\command key a Claude install once wrote is gone on this
  // machine since 2026-09-16), so the value is the fact, and the version is
  // the package's.
  const handler = (scheme) => /URL Protocol/.test(reg(`HKCR\\${scheme}`));
  const versions = {};
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-AppxPackage | Where-Object { $_.Name -in 'Claude','OpenAI.Codex' } | ForEach-Object { $_.Name + ' ' + $_.Version }"], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true });
    for (const m of out.matchAll(/^(Claude|OpenAI\.Codex) (\d+\.\d+\.\d+\.\d+)/gm)) versions[m[1]] = m[2];
  } catch {
    /* not readable: unknown, not absent */
  }
  return [
    { app: 'claudeApp', handler: handler('claude'), version: versions.Claude ?? null },
    { app: 'codexApp', handler: handler('codex'), version: versions['OpenAI.Codex'] ?? null },
  ];
}

export function versionNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function claudeUserConfig() {
  return process.env.CLAUDE_CONFIG_DIR ? join(claudeConfigDir(), '.claude.json') : join(homedir(), '.claude.json');
}

function readJsonConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf-8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected a JSON object');
    if (doc.mcpServers !== undefined && (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers))) throw new Error('expected an mcpServers object');
    return doc;
  } catch {
    throw new BridgeError('BAD_CONFIG', `${path} is not a valid JSON object. Original bytes were left untouched. Fix the JSON (remove any BOM or trailing commas), then re-run the command.`);
  }
}

// Flush a sibling file before rename; the backup is the exact prior bytes,
// not a JSON/TOML round trip. A failed replacement leaves the original intact.
function atomicConfigWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const original = existsSync(path) ? readFileSync(path) : null;
  const mode = original ? statSync(path).mode & 0o777 : 0o600;
  const stage = mkdtempSync(join(dirname(path), '.magi-write-'));
  const flush = (file, bytes) => {
    const fd = openSync(file, 'wx', mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    flush(join(stage, 'next'), text);
    if (original) {
      flush(join(stage, 'backup'), original);
      renameSync(join(stage, 'backup'), path + '.bak');
    }
    renameSync(join(stage, 'next'), path);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

const OWNED_NAMES = ['magi', 'magi-omp', 'magi-codex'];

// One decoder for the safety gate, ownership and inspection. Escaped keys
// need a TOML parser; do not let the line editor silently miss their identity.
function tableHeader(line) {
  const header = /^\s*(\[\[?)(.+?)(\]\]?)\s*(?:#.*)?$/.exec(line.trim());
  if (!header || header[1].length !== header[3].length) return null;
  const key = /([A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')(?:\.(?=.)|$)/gy;
  const keys = [];
  while (key.lastIndex < header[2].length) {
    const part = key.exec(header[2]);
    if (!part) return null;
    keys.push(/^[\"']/.test(part[1]) ? part[1].slice(1, -1) : part[1]);
  }
  return { keys, array: header[1].length === 2 };
}

// This is a conservative editor, not a TOML parser. Reject syntax in which a
// line can look like a table while actually belonging to a value or dotted key.
function assertEditableToml(text) {
  const unsafe = () => { throw new BridgeError('BAD_CONFIG', 'Codex TOML cannot be edited safely. Original bytes were left untouched. Convert inline tables, dotted keys and owned arrays of tables to ordinary [table] sections (Magi uses [mcp_servers.magi]), remove multiline strings, and use headers without escaped keys or spaces around brackets or dots; then re-run the command, or register Magi manually (docs/mcp-config.md).'); };
  if (text.startsWith('\ufeff')) unsafe();
  let arrayDepth = 0;
  for (const line of text.split(/\r?\n/)) {
    let syntax = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (line.slice(i, i + 3) === c.repeat(3)) unsafe();
        quote = c;
        syntax += 'q';
      } else syntax += c;
    }
    if (quote) unsafe();
    const trimmed = syntax.trim();
    if (!trimmed) continue;
    if (arrayDepth && trimmed.startsWith('[')) unsafe();
    if (!arrayDepth && trimmed.startsWith('[')) {
      const header = tableHeader(line);
      if (!header || (header.array && header.keys[0] === 'mcp_servers' && OWNED_NAMES.includes(header.keys[1]))) unsafe();
    } else {
      const at = syntax.indexOf('=');
      if (!arrayDepth && (at < 0 || syntax.slice(0, at).includes('.'))) unsafe();
      const value = arrayDepth ? syntax : syntax.slice(at + 1);
      if (!value.trim() || value.includes('{') || value.includes('}')) unsafe();
      for (const c of value) {
        if (c === '[') arrayDepth++;
        if (c === ']') arrayDepth--;
        if (arrayDepth < 0) unsafe();
      }
    }
  }
  if (arrayDepth) unsafe();
}


function splitOwned(text, keepOwned) {
  assertEditableToml(text);
  let owned = false;
  return text.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) {
      const header = tableHeader(line);
      owned = Boolean(header && !header.array && header.keys[0] === 'mcp_servers' && OWNED_NAMES.includes(header.keys[1]));
    }
    return owned === keepOwned;
  }).join('');
}

export function withoutMagiConfig(text) {
  return splitOwned(text, false);
}

export function magiConfigSection(text) {
  return splitOwned(text, true);
}

// One server's table (and its children) out of a config.toml, whichever way
// the header is quoted; '' when absent.
export function serverTable(text, name) {
  let on = false;
  return text.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) {
      const header = tableHeader(line);
      on = Boolean(header && !header.array && header.keys[0] === 'mcp_servers' && header.keys[1] === name);
    }
    return on;
  }).join('');
}

// Codex kills a tool call at tool_timeout_sec. It must exceed the longest wait
// the bridge itself allows, or a long live review dies on the host side with
// the round left open and no record of why.
export const CODEX_TOOL_TIMEOUT_SEC = Math.ceil(MAX_TIMEOUT_MS / 1000) + 100;

function found(name) {
  try {
    return resolveBin(name);
  } catch {
    return null;
  }
}

// fnm gives each shell its own folder of links (fnm_multishells: under
// $XDG_RUNTIME_DIR on Linux, the user's cache or local app data elsewhere)
// and deletes it when that shell exits; /run/user/<uid> itself is cleared at
// logout. A path through one works only while the shell that ran install is
// open. Returns that root as written in `path`, or null.
export function ephemeralRoot(path, env = process.env) {
  const text = String(path);
  const p = text.replace(/\\/g, '/');
  const fnm = /^(.*?\/fnm_multishells)\//i.exec(p);
  if (fnm) return text.slice(0, fnm[1].length);
  const xdg = env.XDG_RUNTIME_DIR?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (xdg && p.startsWith(xdg + '/')) return text.slice(0, xdg.length);
  const run = /^(\/run\/user\/\d+)\//.exec(p);
  return run ? run[1] : null;
}

// The path install records for a CLI. A path through a per-shell folder is
// replaced by the file behind it. Any other path is kept as found: a link a
// tool maintains is the stable name, and the file behind it is not (Claude's
// ~/.local/bin/claude is repointed at each version by its updater, and the
// old version's file is deleted).
export function stableBin(name, path, { env = process.env } = {}) {
  const key = `${name.toUpperCase()}_BIN`;
  if (!ephemeralRoot(path, env)) return path;
  let real;
  try { real = realpathSync(path); }
  catch { throw new BridgeError('CLI_NOT_FOUND', `${key} resolved to ${path}, which cannot be followed to a file. Set ${key} to the CLI's installed file and re-run install.`); }
  const root = ephemeralRoot(real, env);
  if (root) {
    throw new BridgeError('EPHEMERAL_BIN', `${key} would be recorded as ${real}, which is under ${root}, a per-shell folder that is deleted when its shell exits. Set ${key} to the CLI's installed file outside it (with fnm, under ~/.local/share/fnm/node-versions/<version>/installation/) and re-run install.`);
  }
  let stat;
  try { stat = statSync(real); } catch { stat = null; }
  if (!stat?.isFile()) throw new BridgeError('CLI_NOT_FOUND', `${key} resolved to ${real}, which is not a regular file. Set ${key} to the CLI's installed file and re-run install.`);
  // spawnFile runs a .js under node; anything else must be executable itself.
  if (platform() !== 'win32' && !/\.[cm]?js$/i.test(real)) {
    try { accessSync(real, constants.X_OK); }
    catch { throw new BridgeError('CLI_NOT_FOUND', `${key} resolved to ${real}, which is not executable. Set ${key} to the CLI's installed executable and re-run install.`); }
  }
  return real;
}

// The *_BIN values written into every harness config; computed before the
// first write, so a refused path leaves every config as it was.
function pinnedBins() {
  const pin = (name) => {
    const path = found(name);
    return path && stableBin(name, path);
  };
  return { CLAUDE_BIN: pin('claude'), CODEX_BIN: pin('codex'), OMP_BIN: pin('omp') };
}

// Install writes only these into a server's env. Any other key there was set by
// someone else (MAGI_WORKER_WRAPPER, say) and survives a reinstall, which
// otherwise rebuilds the entry from scratch.
const OWNED_ENV = new Set(['CLAUDE_BIN', 'CODEX_BIN', 'OMP_BIN']);

export function foreignEnv(env) {
  return Object.fromEntries(Object.entries(env && typeof env === 'object' ? env : {})
    .filter(([key, value]) => !OWNED_ENV.has(key) && typeof value === 'string'));
}

// The basic-string keys of a Codex [mcp_servers.<name>.env] table; other
// value forms are not ones Magi or a script would write, and are skipped.
export function tomlEnv(text, name = 'magi') {
  let inEnv = false;
  const env = {};
  for (const row of (text ?? '').split(/\r?\n/)) {
    if (/^\s*\[/.test(row)) {
      const header = tableHeader(row);
      inEnv = Boolean(header && !header.array && header.keys.join('.') === `mcp_servers.${name}.env`);
      continue;
    }
    const m = inEnv && /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(row);
    if (m) try { env[m[1]] = JSON.parse(m[2]); } catch { /* not a basic string */ }
  }
  return env;
}

function recordBins(bins) {
  const home = magiHomeDir();
  mkdirSync(home, { recursive: true });
  const kept = Object.fromEntries(Object.entries(bins).filter(([, v]) => v));
  const path = join(home, BINS_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(kept, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

// One [mcp_servers.<name>] table. env_vars is what carries PEER_DEPTH across
// the Codex hop; Codex does not forward the parent environment to MCP servers
// by default. The resolved paths are pinned as well, since none of the CLIs
// is reliably on PATH.
function tomlTable(name, serveArgs, bins) {
  const lines = [
    `[mcp_servers.${name}]`,
    'command = "node"',
    `args = [${JSON.stringify(CLI)}, ${serveArgs.map((a) => JSON.stringify(a)).join(', ')}]`,
    'env_vars = ["PEER_DEPTH", "PEER_ROLE", "PEER_TASK_ID", "MAGI_HOME"]',
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    'startup_timeout_sec = 30',
  ];
  const env = Object.entries(bins).filter(([, v]) => v);
  if (env.length) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [k, v] of env) lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function tomlSection({ omp = Boolean(found('omp')), bins = pinnedBins(), keep = {} } = {}) {
  // One server per session: with omp it serves both peers as Codex, instead of
  // a second process. A magi-omp table from an older install is stripped.
  return tomlTable('magi', omp ? ['serve', 'claude', 'omp', '--as', 'codex'] : ['serve', 'claude'], { ...bins, ...foreignEnv(keep) });
}

// Subscription usage for Claude comes only through its statusline JSON, so
// this chains `magi statusline` in front of whatever the user has. An
// opt-in, because it edits settings.json; the original command is kept in
// magi.db settings/statusline-chain (legacy file read fallback) and restored on uninstall.
export const STATUSLINE_COMMAND = `node ${JSON.stringify(CLI)} statusline`;

export function installUsage() {
  const path = join(claudeConfigDir(), 'settings.json');
  const doc = readJsonConfig(path);
  const current = doc.statusLine;
  const ours = current?.type === 'command' && /magi\.mjs" statusline$/.test(String(current.command ?? ''));
  if (!ours) writeChain(current?.type === 'command' && current.command ? { command: current.command } : null);
  doc.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
  atomicConfigWrite(path, JSON.stringify(doc, null, 2) + '\n');
  const chain = readChain();
  console.log(`Claude statusLine is ${STATUSLINE_COMMAND}${chain?.command ? `, then your own: ${chain.command}` : ''}`);
}

export function uninstallUsage() {
  const path = join(claudeConfigDir(), 'settings.json');
  if (!existsSync(path)) return;
  const doc = readJsonConfig(path);
  const current = doc.statusLine;
  if (!(current?.type === 'command' && /magi\.mjs/.test(String(current.command ?? '')))) return;
  const chain = readChain();
  if (chain?.command) doc.statusLine = { type: 'command', command: chain.command };
  else delete doc.statusLine;
  atomicConfigWrite(path, JSON.stringify(doc, null, 2) + '\n');
  writeChain(null);
  console.log(`Claude statusLine restored${chain?.command ? ` to ${chain.command}` : ''}.`);
}

export async function install({ claude, codex, omp, usage, skillsOnly, root = ROOT } = {}) {
  // --usage alone edits only the statusline; beside a harness flag it runs
  // after that harness's install, so `--omp --usage` does both.
  if (usage && !claude && !codex && !omp && !skillsOnly) {
    installUsage();
    return;
  }
  const both = !claude && !codex && !omp;
  // omp is a third harness, only wired up when it is actually present: its
  // own side (servers, inbox extension, skills) and, in Claude and Codex, the
  // server that lets them consult it.
  const codexPath = join(codexHome(), 'config.toml');
  const codexText = existsSync(codexPath) ? readFileSync(codexPath, 'utf-8') : '';
  if (!skillsOnly && (codex || both || omp)) assertEditableToml(codexText);
  const discoveryJson = (path) => {
    try { return readJsonConfig(path); } catch { return {}; }
  };
  const claudeDoc = !skillsOnly && (claude || both || omp)
    ? readJsonConfig(claudeUserConfig()) : discoveryJson(claudeUserConfig());
  const ompDoc = discoveryJson(join(ompHome(), 'mcp.json'));
  const existingOmp = Boolean(
    claudeDoc.mcpServers?.magi?.args?.includes('omp') || claudeDoc.mcpServers?.['magi-omp'] ||
    /["']omp["']/.test(serverTable(codexText, 'magi')) || serverTable(codexText, 'magi-omp') ||
    OWNED_NAMES.some((name) => ompDoc.mcpServers?.[name]) ||
    existsSync(join(ompHome(), 'extensions', 'magi', 'index.js'))
  );
  const withOmp = omp || Boolean(found('omp')) || existingOmp;
  if (!skillsOnly && withOmp) readJsonConfig(join(ompHome(), 'mcp.json'));
  const bins = skillsOnly ? null : pinnedBins();
  // The same paths beside the state, for what no harness starts (an ssh
  // command on this machine as a remote; exec.mjs recordedBin).
  if (bins) recordBins(bins);
  // --omp alone still (re)registers Claude and Codex. Single-harness updates
  // keep the already-installed third peer and its skills.
  if (!skillsOnly && (claude || both || omp)) {
    await installClaudeMcp({ omp: withOmp, bins });
    await installClaudeView(root);
  }
  if (!skillsOnly && (codex || both || omp)) installCodexMcp({ omp: withOmp, bins });
  installSkills(root, { omp: withOmp });
  if (withOmp) installOmp(root, { skillsOnly, bins });
  const stale = removeStaleStartup();
  if (stale.length) console.log(`Removed the old dashboard login entry: ${stale.join(', ')}`);
  if (usage) installUsage();
  console.log('\nDone. Restart Claude Code, Codex and omp so they pick up the servers.');
}

// The web dashboard, removed in favour of the Claude Code mod's /magi pane,
// could start at login from these Startup files; install and uninstall both
// delete them so an old install stops launching a server that no longer exists.
const STALE_STARTUP = ['magi-dashboard.cmd'];
function removeStaleStartup() {
  const dir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const found = STALE_STARTUP.map((name) => join(dir, name)).filter((file) => existsSync(file));
  for (const file of found) rmSync(file, { force: true });
  return found;
}

// --- Oh My Pi (omp) --------------------------------------------------------
//
// omp reads MCP servers from ~/.omp/agent/mcp.json (its own config, priority
// over anything it imports from Claude's), extensions from
// ~/.omp/agent/extensions/<name>/index.js, and skills from
// ~/.omp/agent/skills/. Its MCP request timeout is 30 s unless the server's
// own entry says otherwise, and the bridge blocks for up to an hour, so the
// entries carry `timeout: 0`. That key is honoured only in omp-owned config,
// which is why the servers are written here and not inherited from
// ~/.claude.json.
function ompHome() {
  return process.env.OMP_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');
}

export const OMP_SERVERS = {
  magi: { peer: 'claude', tool: 'claude_peer' },
  'magi-codex': { peer: 'codex', tool: 'codex_peer' },
  'magi-omp': { peer: 'omp', tool: 'omp_peer' },
};

// Pure: merge our entries into an mcp.json document, keeping everything
// else the user has there. Exported so a test can check it without touching
// the real config.
export function withOmpServers(text, { cli = CLI, bins = pinnedBins() } = {}) {
  let doc = {};
  if (text && text.trim()) {
    try { doc = JSON.parse(text); } catch { throw new BridgeError('BAD_CONFIG', 'omp mcp.json is not valid JSON; fix or remove it and re-run install.'); }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new BridgeError('BAD_CONFIG', 'omp mcp.json must be a JSON object; fix it and re-run install.');
  if (doc.mcpServers !== undefined && (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers))) throw new BridgeError('BAD_CONFIG', 'omp mcpServers must be a JSON object; fix it and re-run install.');
  doc.mcpServers ??= {};
  const pinned = Object.fromEntries(Object.entries(bins).filter(([, v]) => v));
  const kept = Object.fromEntries(Object.keys(OMP_SERVERS).map((name) => [name, foreignEnv(doc.mcpServers[name]?.env)]));
  for (const name of OWNED_NAMES) delete doc.mcpServers[name];
  for (const [name, { peer }] of Object.entries(OMP_SERVERS)) {
    const env = { ...pinned, ...kept[name] };
    doc.mcpServers[name] = { type: 'stdio', command: 'node', args: [cli, 'serve', peer, '--as', 'omp'], timeout: 0, ...(Object.keys(env).length ? { env } : {}) };
  }
  return JSON.stringify(doc, null, 2) + '\n';
}

export function withoutOmpServers(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return text; }
  if (!doc?.mcpServers) return text;
  for (const name of OWNED_NAMES) delete doc.mcpServers[name];
  return JSON.stringify(doc, null, 2) + '\n';
}

function installOmp(root, { skillsOnly, bins } = {}) {
  const home = ompHome();
  mkdirSync(home, { recursive: true });
  if (!skillsOnly) {
    const path = join(home, 'mcp.json');
    readJsonConfig(path);
    atomicConfigWrite(path, withOmpServers(existsSync(path) ? readFileSync(path, 'utf-8') : '', { bins }));
    console.log(`Wrote ${Object.keys(OMP_SERVERS).join(' and ')} (serving omp, no MCP timeout) to ${path}`);
  }
  // The inbox extension: registers the session and turns inbox frames into
  // user turns. Without it omp can ask but cannot be answered out of band.
  const extDir = join(home, 'extensions', 'magi');
  mkdirSync(extDir, { recursive: true });
  cpSync(join(root, 'omp', 'magi-omp-extension.js'), join(extDir, 'index.js'));
  cpSync(join(root, 'omp', 'process-identity.js'), join(extDir, 'process-identity.js'));
  console.log(`Installed extension -> ${join(extDir, 'index.js')}`);
  for (const skill of ['peer-claude', 'peer-codex', 'peer-omp']) installSkill(root, skill, join(home, 'skills', skill));
}

function uninstallOmp() {
  const home = ompHome();
  const path = join(home, 'mcp.json');
  if (existsSync(path)) {
    readJsonConfig(path);
    atomicConfigWrite(path, withoutOmpServers(readFileSync(path, 'utf-8')));
    console.log(`Removed ${Object.keys(OMP_SERVERS).join(' and ')} from ${path}`);
  }
  for (const d of [join(home, 'extensions', 'magi'), join(home, 'skills', 'peer-claude'), join(home, 'skills', 'peer-codex'), join(home, 'skills', 'peer-omp')]) {
    if (!existsSync(d)) continue;
    rmSync(d, { recursive: true, force: true });
    console.log(`Removed ${d}`);
  }
}

async function installClaudeMcp({ omp = false, bins = pinnedBins() } = {}) {
  resolveBin('claude');
  const path = claudeUserConfig();
  readJsonConfig(path);
  const env = Object.fromEntries([
    ['CODEX_BIN', bins.CODEX_BIN], ['CLAUDE_BIN', bins.CLAUDE_BIN], ['OMP_BIN', bins.OMP_BIN],
  ].filter(([, value]) => value));
  const serveArgs = omp ? ['serve', 'codex', 'omp', '--as', 'claude'] : ['serve', 'codex'];
  // Claude refuses an existing name. Validate every add in a fresh config,
  // then atomically merge it; a failed CLI cannot touch the working entry.
  let entry;
  const stage = mkdtempSync(join(tmpdir(), 'magi-register-'));
  try {
    const flags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const result = await runCli('claude', ['mcp', 'add', 'magi', '-s', 'user', ...flags, '--', 'node', CLI, ...serveArgs], { env: { CLAUDE_CONFIG_DIR: stage }, timeoutMs: 20000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Claude exited ${result.exitCode}`);
    entry = readJsonConfig(join(stage, '.claude.json')).mcpServers?.magi;
    if (!entry || entry.command !== 'node' || !Array.isArray(entry.args) || entry.args[0] !== CLI) throw new Error('Claude did not write the expected user MCP entry');
  } catch (e) {
    if (e.code === 'CMD_UNSAFE_ARGUMENT') throw e;
    throw new BridgeError('REGISTRATION_FAILED', `Claude MCP registration failed; existing registrations were left untouched. Check CLAUDE_BIN, run "claude mcp add --help", fix the reported CLI error and re-run install: ${e.message}`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  // Other sessions may change unrelated entries while the CLI is running.
  const doc = readJsonConfig(path);
  doc.mcpServers ??= {};
  const kept = foreignEnv(doc.mcpServers.magi?.env);
  if (Object.keys(kept).length) entry.env = { ...entry.env, ...kept };
  doc.mcpServers.magi = entry;
  for (const name of OWNED_NAMES) if (name !== 'magi') delete doc.mcpServers[name];
  atomicConfigWrite(path, JSON.stringify(doc, null, 2) + '\n');
  console.log('Registered the "magi" MCP server in Claude Code (user scope).');
}

function installCodexMcp({ omp = false, bins = pinnedBins() } = {}) {
  const path = join(codexHome(), 'config.toml');
  mkdirSync(codexHome(), { recursive: true });
  let text = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const keep = tomlEnv(text);
  const removed = withoutMagiConfig(text);
  const had = removed !== text;
  text = removed;
  const sep = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  atomicConfigWrite(path, text + sep + tomlSection({ omp, bins, keep }));
  console.log(`${had ? 'Updated' : 'Added'} [mcp_servers.magi]${omp ? ' (claude and omp in one server)' : ''} in ${path}`);
}

// One skill directory, installed. The protocol is a single file in the repo
// and every skill says "read PROTOCOL.md next to this file", so it is copied
// beside each SKILL.md here rather than kept in three places in the source.
export function installSkill(root, name, dst) {
  const src = join(root, 'skills', name);
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  // Replace, do not merge: a file deleted from the source must not survive
  // in the installed copy.
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  cpSync(join(root, 'skills', 'PROTOCOL.md'), join(dst, 'PROTOCOL.md'));
  console.log(`Installed skill -> ${dst}`);
  return true;
}

// What omp being enabled adds to Claude's and Codex's skills.
const OMP_SKILLS = ['peer-omp', 'omp-advisor'];

function installSkills(root, { omp = false } = {}) {
  installSkill(root, 'peer-codex', join(claudeConfigDir(), 'skills', 'peer-codex'));
  installSkill(root, 'peer-claude', join(homedir(), '.agents', 'skills', 'peer-claude'));
  // The skills for consulting omp, and for its advisor, go to both
  // orchestrating harnesses.
  for (const skills of [join(claudeConfigDir(), 'skills'), join(homedir(), '.agents', 'skills')]) {
    for (const name of OMP_SKILLS) {
      if (omp) installSkill(root, name, join(skills, name));
      else rmSync(join(skills, name), { recursive: true, force: true });
    }
  }
}

// The magi-view mod (claude-mod/) draws peer messages without Magi's protocol
// text; the model still reads all of it. It is a folder marketplace in this
// checkout, but Claude Code copies the plugin into a versioned cache at
// install and every session outside this checkout loads that copy, so each
// install refreshes the marketplace and updates the plugin as well; without
// that a project elsewhere ran the first version long after it was replaced.
// Cosmetic: a failure is reported and never fails the install.
async function installClaudeView(root) {
  // The cached copy has no checkout above it: this file tells it where
  // bin/magi.mjs is, and is copied into the cache by the steps below.
  try {
    writeFileSync(join(root, 'claude-mod', 'checkout.json'), JSON.stringify({ checkout: root }) + '\n');
  } catch (e) {
    console.warn(`magi-view could not record this checkout (${e.message}); the deck works only in sessions started in ${root}.`);
  }
  const steps = [
    ['plugin', 'marketplace', 'add', root, '--scope', 'user', '--json'],
    ['plugin', 'install', 'magi-view@magi', '--scope', 'user', '--json'],
    ['plugin', 'marketplace', 'update', 'magi'],
    ['plugin', 'update', 'magi-view@magi', '--scope', 'user'],
  ];
  for (const args of steps) {
    try {
      const result = await runCli('claude', args, { timeoutMs: 60000 });
      const said = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.exitCode !== 0 && !/already/i.test(said)) throw new Error(said.trim() || `exit ${result.exitCode}`);
    } catch (e) {
      console.warn(`magi-view (cleaner peer messages in Claude Code) was not installed: ${e.message}. Run "claude ${args.filter(arg => arg !== '--json').join(' ')}" to retry; Magi works without it.`);
      return;
    }
  }
  console.log('Installed the magi-view mod in Claude Code (peer messages drawn without protocol text; /reload-plugins or restart to load it).');
}

async function uninstallClaudeView() {
  for (const args of [['plugin', 'uninstall', 'magi-view@magi', '--json'], ['plugin', 'marketplace', 'remove', 'magi', '--json']]) {
    try { await runCli('claude', args, { timeoutMs: 60000 }); } catch { /* not installed, or no claude CLI */ }
  }
}

export async function uninstall() {
  await uninstallClaudeView();
  const claudePath = claudeUserConfig();
  if (existsSync(claudePath)) {
    const doc = readJsonConfig(claudePath);
    if (doc.mcpServers) for (const name of OWNED_NAMES) delete doc.mcpServers[name];
    atomicConfigWrite(claudePath, JSON.stringify(doc, null, 2) + '\n');
    console.log(`Removed Magi user MCP entries from ${claudePath}`);
  }
  const path = join(codexHome(), 'config.toml');
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf-8');
    atomicConfigWrite(path, withoutMagiConfig(text));
    console.log(`Removed Magi MCP tables from ${path}`);
  }
  for (const d of [
    join(claudeConfigDir(), 'skills', 'peer-codex'), join(homedir(), '.agents', 'skills', 'peer-claude'),
    ...[join(claudeConfigDir(), 'skills'), join(homedir(), '.agents', 'skills')].flatMap((skills) => OMP_SKILLS.map((name) => join(skills, name))),
  ]) {
    try {
      rmSync(d, { recursive: true, force: true });
      console.log(`Removed ${d}`);
    } catch {
      /* nothing there */
    }
  }
  uninstallOmp();
  try {
    uninstallUsage();
  } finally {
    removeStaleStartup();
  }
}

// Every *_BIN that install wrote into the three harness configs, with where
// it was found. An unreadable config is reported by its own doctor row.
export function configuredBins() {
  const out = [];
  const add = (where, env) => {
    for (const [key, value] of Object.entries(env ?? {})) if (/_BIN$/.test(key) && typeof value === 'string') out.push({ where, key, value });
  };
  const json = (path) => { try { return readJsonConfig(path); } catch { return {}; } };
  const claudePath = claudeUserConfig();
  add(`${claudePath} (mcpServers.magi.env)`, json(claudePath).mcpServers?.magi?.env);
  const codexPath = join(codexHome(), 'config.toml');
  add(`${codexPath} ([mcp_servers.magi.env])`, tomlEnv(existsSync(codexPath) ? readFileSync(codexPath, 'utf-8') : ''));
  const ompPath = join(ompHome(), 'mcp.json');
  const omp = json(ompPath).mcpServers ?? {};
  for (const name of Object.keys(OMP_SERVERS)) add(`${ompPath} (mcpServers.${name}.env)`, omp[name]?.env);
  return out;
}


// The checks as rows, so the CLI can print them and tests can read them.
export async function doctorReport() {
  const { getProviders, setProvider } = await import('./providers.mjs');
  const { looksLikeAuthFailure, authError } = await import('./exec.mjs');
  let providers;
  const enabled = (name) => providers[name].enabled;
  const recordAuth = (name, text) => {
    if (!looksLikeAuthFailure(text)) return false;
    const error = authError(name, text);
    setProvider(name, { down: `${error.code}: ${error.message}` });
    line(false, `${name}: down (${error.code}: ${error.message})`);
    return true;
  };
  const rows = [];
  const line = (good, msg) => rows.push({ level: good ? 'ok' : 'fail', text: msg });
  const warn = (msg) => rows.push({ level: 'warn', text: msg });


  // Read raw rows: listWorkers/sweep would remove the evidence being diagnosed.
  let stateHealthy = false;
  try {
    const { magiHome, readTask } = await import('./state.mjs');
    const { database, listRecords } = await import('./store.mjs');
    const home = magiHome();
    const db = database(home);
    const checks = db.prepare('PRAGMA quick_check').all();
    stateHealthy = checks.length === 1 && Object.values(checks[0])[0] === 'ok';
    line(stateHealthy, `database ${join(home, 'magi.db')}: quick_check ${stateHealthy ? 'ok' : 'failed; stop Magi servers, restore magi.db from a known-good backup, then run "magi doctor"'}`);
    if (stateHealthy) {
      const dead = (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try { process.kill(pid, 0); return false; }
        catch (error) { return error.code === 'ESRCH'; }
      };
      const now = Date.now();
      const waiters = db.prepare('SELECT pid FROM waiters').all().filter((row) => dead(row.pid));
      const workers = listRecords(home, 'workers').filter((row) => dead(row.pid) ||
        now - row.startedAt > (row.timeoutMs ?? 2400000));
      const questions = db.prepare('SELECT value FROM questions').all().map((row) => JSON.parse(row.value)).filter((question) => {
        if (question.answeredAt || now - question.askedAt <= 86400000) return false;
        const round = readTask(question.taskId)?.rounds.find((entry) => entry.round === question.round);
        return round && !round.closedAt && !round.replied;
      });
      line(!waiters.length, `stuck waiters (dead pid): ${waiters.length}${waiters.length ? '; run "magi sweep"' : ''}`);
      line(!workers.length, `stuck workers (dead pid or past timeout): ${workers.length}${workers.length ? '; restart the owning Magi server to stop its children, then run "magi sweep"' : ''}`);
      line(!questions.length, `open questions older than one day: ${questions.length}${questions.length ? '; answer them through clarify_answer, or close abandoned cards: ' + [...new Set(questions.map((q) => q.taskId))].map((id) => `magi close --task ${id}`).join('; ') : ''}`);

      // Read persisted holds, not relay stderr: a healthy ssh connection buffers
      // that warning. Project metadata only; every event is reported each run,
      // with bounded fields so neither bodies nor terminal controls reach doctor.
      const held = db.prepare(`SELECT key AS id,
        json_extract(value,'$.taskId') AS taskId, json_extract(value,'$.round') AS round,
        json_extract(value,'$.at') AS at, json_extract(value,'$.legacyHold') AS reason
        FROM records WHERE namespace='relay-outbox' AND json_valid(value)
        AND json_type(value,'$.legacyHold')='text' AND length(json_extract(value,'$.legacyHold'))>0
        ORDER BY key`).all();
      const field = (value, max) => redact(String(value ?? '(missing)')).text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max);
      if (!held.length) line(true, 'held relay events: 0');
      else {
        warn(`held relay events: ${held.length}; retained here. Inspect the exact mirror round with "magi exchange <task_id>" on both machines; expired holds need manual reconciliation.`);
        for (const event of held) {
          const age = typeof event.at === 'number' && Number.isFinite(event.at) ? `${Math.max(0, Math.floor((now - event.at) / 1000))}s` : '(unknown)';
          warn(`RELAY_LEGACY_EVENT_HELD event_id=${field(event.id, 80)} task_id=${field(event.taskId, 80)} round=${field(event.round, 24)} age=${age} reason=${field(event.reason, 200)}`);
        }
      }
    }
  } catch (error) {
    const busy = error.code === 'LEDGER_BUSY' || error.errcode === 5 || error.errcode === 6;
    line(false, busy
      ? 'database health: LEDGER_BUSY. Wait for the active transaction to finish, then run "magi doctor"; do not restore or delete the database.'
      : `database health: ${error.code ?? 'DATABASE_CHECK_FAILED'}: ${error.message}. Stop Magi servers, restore magi.db from a known-good backup, then run "magi doctor".`);
  }
  if (!stateHealthy) return rows;
  providers = getProviders();
  for (const name of Object.keys(providers).filter(enabled)) {
    if (providers[name].status === 'down') line(false, `${name}: down (${providers[name].reason})`);
    try {
      line(true, `${name}: ${resolveBin(name)}`);
    } catch (e) {
      line(false, `${name}: ${e.message}`);
      continue;
    }
    // A version check that fails is not a doctor failure; drift is only a warning.
    try {
      const result = await runCli(name, ['--version'], { timeoutMs: 20000 });
      if (recordAuth(name, `${result.stdout}\n${result.stderr}`)) continue;
      const v = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
      if (v && versionNewer(v, VERIFIED_VERSIONS[name])) {
        warn(`${name} ${v} is newer than the last verified ${VERIFIED_VERSIONS[name]}; live delivery into it is unverified and a break is silent (deliveries stay unconfirmed and replies never come; docs/transport-recon.md)`);
      }
    } catch (e) {
      recordAuth(name, e.message);
    }
  }

  // A server reads its *_BIN at start and resolveBin fails loudly on one that
  // is gone, so a stale path here breaks every headless call from that harness.
  const pinned = configuredBins();
  const stale = pinned.filter(({ value }) => !existsSync(value) || ephemeralRoot(value));
  for (const { where, key, value } of stale) {
    const root = ephemeralRoot(value);
    const why = !existsSync(value) ? 'does not exist' : `is under ${root}, a per-shell folder deleted when its shell exits`;
    line(false, `${key} in ${where} is ${value}, which ${why}. Close the harnesses, run "magi install" (it records the file behind a per-shell link), then restart them.`);
  }
  if (pinned.length && !stale.length) line(true, `configured CLI paths: ${pinned.length}, all present and outside per-shell folders`);
  try {
    const { filesEnabled } = await import('./artifacts.mjs');
    line(true, `files between machines: ${filesEnabled() ? 'on ("magi files off" turns it off)' : 'off, the default ("magi files on" on both machines turns it on)'}`);
  } catch { /* the database check above reports an unreadable ledger */ }

  for (const a of enabled('claude') || enabled('codex') ? desktopApps() : []) {
    if (!enabled(a.app === 'claudeApp' ? 'claude' : 'codex')) continue;
    const label = a.app === 'claudeApp' ? 'Claude Code app (claude://)' : 'Codex app (codex://)';
    const ver = a.version ? `version ${a.version}` : 'version not seen';
    const drift = a.version && versionNewer(a.version, VERIFIED_VERSIONS[a.app]) ? `, newer than the last verified ${VERIFIED_VERSIONS[a.app]}: spawn --app is unverified there` : '';
    if (a.handler) line(true, `${label}: URL handler registered, ${ver}${drift}`);
    else warn(`${label}: no URL handler seen, ${ver}; spawn --app for it will report SPAWN_FAILED`);
    // The app-server being reachable says nothing about steer: that rides the
    // desktop's own app-tools pipe, which a desktop update can hide. A closed
    // app is normal, so a miss is a warning.
    if (a.app === 'codexApp') {
      const env = await findAppTools();
      if (env) line(true, `Codex app steer channel found (${env.pipe})`);
      else warn('Codex app steer channel not found: steer returns NO_STEER_CHANNEL. Open the Codex desktop app; if it is already open, its channel changed (docs/transport-recon.md, "Desktop steer channel")');
    }
  }

  if (enabled('claude')) {
    const sessions = listClaudeSessions();
    line(true, `live Claude sessions: ${sessions.length}${sessions.length ? ' (' + sessions.map((s) => s.name ?? s.pid).join(', ') + ')' : ''}`);
  }

  if (enabled('codex')) try {
    const t = await listCodexThreads({ limit: 5 });
    line(true, `codex app-server reachable, ${t.length} recent thread(s)`);
  } catch (e) {
    recordAuth('codex', e.message);
    line(false, `codex app-server: ${e.code ?? e.message}`);
  }

  const codexCfg = join(codexHome(), 'config.toml');
  const cfgText = enabled('codex') && existsSync(codexCfg) ? readFileSync(codexCfg, 'utf-8') : '';
  const activeCodex = serverTable(cfgText, 'magi');
  const registeredCodex = Boolean(activeCodex);
  if (enabled('codex')) line(registeredCodex, `codex config.toml has [mcp_servers.magi]`);
  if (enabled('codex') && registeredCodex) {
    const need = Math.ceil(MAX_TIMEOUT_MS / 1000);
    let rootTable = '';
    let inRoot = false;
    for (const row of activeCodex.split(/\r?\n/)) {
      if (/^\s*\[/.test(row)) {
        const header = tableHeader(row);
        inRoot = Boolean(header && !header.array && header.keys.length === 2);
      }
      else if (inRoot) rootTable += row + '\n';
    }
    const set = Number(/^\s*tool_timeout_sec\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(rootTable)?.[1]);
    line(set >= need, `codex tool_timeout_sec=${Number.isFinite(set) ? set : 'unset'} covers the ${need}s maximum wait (re-run install if not)`);
  }

  let claudeServers = {};
  if (enabled('claude')) {
    try { claudeServers = readJsonConfig(claudeUserConfig()).mcpServers ?? {}; }
    catch (e) { line(false, `claude user config: ${e.code ?? 'BAD_CONFIG'}; ${e.message}`); }
    line(Boolean(claudeServers.magi), `claude magi MCP registration in user config (${claudeUserConfig()}; re-run install --claude if missing)`);

    // A bypass-class receiver holds peer messages unless inbound policy accepts
    // them; its dialog expiry is reported separately, including the never case.
    const settings = readClaudeDialogSettings();
    const inbound = settings?.crossSessionInbound ?? null;
    line(inbound === 'accept', `claude settings.json crossSessionInbound=${inbound ?? 'unset'} (needs "accept", or bypass sessions hold peer messages for approval)`);
    rows.push({ level: 'info', text: claudeDialogTimeoutInfo(settings) });
  }

  const skillA = join(claudeConfigDir(), 'skills', 'peer-codex', 'SKILL.md');
  const skillB = join(homedir(), '.agents', 'skills', 'peer-claude', 'SKILL.md');
  if (enabled('claude') && enabled('codex')) {
    line(existsSync(skillA), `claude skill installed (${skillA})`);
    line(existsSync(skillB), `codex skill installed (${skillB})`);
  }

  // Missing enabled providers are reported above; only installed omp has integrations.
  if (enabled('omp') && found('omp')) {
    const home = ompHome();
    let servers = {};
    try { servers = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf-8')).mcpServers ?? {}; } catch { /* no config */ }
    const active = Object.keys(OMP_SERVERS).filter((name) => enabled(OMP_SERVERS[name].peer));
    const missing = active.filter((n) => !servers[n]);
    const slow = active.filter((n) => servers[n] && servers[n].timeout !== 0);
    if (active.length) {
      line(!missing.length, `omp mcp.json has ${active.join(' and ')}${missing.length ? ` (missing ${missing.join(', ')}; run "magi install --omp")` : ''}`);
      if (!missing.length) line(!slow.length, `omp entries disable the 30s MCP timeout${slow.length ? ` (${slow.join(', ')} would abort a blocking review; re-run install --omp)` : ''}`);
    }
    line(existsSync(join(home, 'extensions', 'magi', 'index.js')), `omp inbox extension installed (${join(home, 'extensions', 'magi', 'index.js')})`);
    line(existsSync(join(home, 'skills', 'peer-omp', 'SKILL.md')), 'peer-omp skill installed for omp (re-run "magi install --omp" if not)');
    const { listAgentSessions } = await import('./transport.mjs');
    const omps = listAgentSessions('omp');
    line(true, `live omp sessions: ${omps.length}${omps.length ? ' (' + omps.map((s) => s.name ?? s.pid).join(', ') + ')' : ' (none registered; the extension registers each session at start)'}`);
    // The other direction: Claude and Codex consulting omp.
    const claudeHasOmp = Boolean(claudeServers.magi?.args?.includes('omp'));
    const claudeSplit = Boolean(claudeServers['magi-omp']);
    if (enabled('claude')) {
      line(claudeHasOmp, 'claude\'s magi server also serves omp_peer (re-run "magi install --omp" if not)');
      line(!claudeSplit, 'claude has no separate magi-omp server (it would cost a second process per session)');
      line(existsSync(join(claudeConfigDir(), 'skills', 'peer-omp', 'SKILL.md')), 'peer-omp skill installed for claude');
      line(existsSync(join(claudeConfigDir(), 'skills', 'omp-advisor', 'SKILL.md')), 'omp-advisor skill installed for claude (re-run "magi install --omp" if not)');
    }
    if (enabled('codex')) {
      line(/args = \[[^\]]*"omp"/.test(serverTable(cfgText, 'magi')), 'codex\'s [mcp_servers.magi] also serves omp_peer (re-run "magi install --omp" if not)');
      line(!serverTable(cfgText, 'magi-omp'),'codex config.toml has no separate [mcp_servers.magi-omp] (it would cost a second process per session)');
      line(existsSync(join(homedir(), '.agents', 'skills', 'peer-omp', 'SKILL.md')), 'peer-omp skill installed for codex');
      line(existsSync(join(homedir(), '.agents', 'skills', 'omp-advisor', 'SKILL.md')), 'omp-advisor skill installed for codex (re-run "magi install --omp" if not)');
    }
  }

  if (stateHealthy) {
    const { stats } = await import('./memory.mjs');
    const all = await stats({ scope: 'all' });
    line(true, `shared memory: ${all.units} unit(s) in ${all.banks} bank(s) in ${all.database}`);
  }

  if (Number(process.env.PEER_DEPTH ?? '0') >= 1) line(false, 'PEER_DEPTH>=1 in this shell: this would refuse to orchestrate');

  return rows;
}

export async function doctor() {
  const rows = await doctorReport();
  const mark = { ok: '  ok  ', fail: ' FAIL ', warn: '  warn ', info: '  info ' };
  for (const r of rows) console.log(`${mark[r.level]} ${r.text}`);
  return rows.every((r) => r.level !== 'fail');
}
