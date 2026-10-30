import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, ROOT, isWin } from './helpers/harness.mjs';

async function fixture(fn, { omp = false, failAdd = false } = {}) {
  const ws = makeWorkspace('installer');
  const saved = { ...process.env };
  const home = join(ws, 'home');
  const cfg = join(home, '.claude');
  const codex = join(home, '.codex');
  const agent = join(home, '.omp', 'agent');
  const appdata = join(home, 'AppData', 'Roaming');
  for (const d of [cfg, codex, agent, appdata]) mkdirSync(d, { recursive: true });
  const script = join(ws, 'cli.cjs');
  writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('99.0.0');process.exit(0);}if(args[0]==='mcp'){if(args[1]==='add'){if(process.env.INSTALL_FAIL_ADD==='1'){console.error('registration rejected');process.exit(7);}const file=path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json');let doc=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};doc.mcpServers??={};if(doc.mcpServers[args[2]])process.exit(8);const at=args.indexOf('--');const env={};for(let i=3;i<at;i++)if(args[i]==='-e'){const kv=args[++i];env[kv.slice(0,kv.indexOf('='))]=kv.slice(kv.indexOf('=')+1);}doc.mcpServers[args[2]]={type:'stdio',command:args[at+1],args:args.slice(at+2),env};fs.writeFileSync(file,JSON.stringify(doc));}process.exit(0);}process.exit(1);`);
  const cli = join(ws, isWin ? 'claude.cmd' : 'claude');
  writeFileSync(cli, isWin ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (!isWin) chmodSync(cli, 0o755);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: appdata, CLAUDE_CONFIG_DIR: cfg, CLAUDE_APP_SESSIONS_DIR: join(appdata, 'Claude', 'claude-code-sessions'), CODEX_HOME: codex, OMP_AGENT_DIR: agent, MAGI_HOME: join(ws, 'magi-state'), MAGI_TEST_HOME: join(ws, 'magi-state'), CLAUDE_BIN: cli, CODEX_BIN: join(ws, 'absent-codex'), OMP_BIN: omp ? cli : join(ws, 'absent-omp'), INSTALL_FAIL_ADD: failAdd ? '1' : '0' });
  const orig = console.log;
  console.log = () => {};
  try { await fn({ ws, home, cfg, codex, agent, appdata, cli, api: await import('../src/install.mjs') }); }
  finally { console.log = orig; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); try { rmSync(ws, { recursive: true, force: true }); } catch { /* magi.db stays open in-process on Windows */ } }
}

for (const text of ['\ufeff{"crossSessionInbound":"accept"}', '{"permissions":{},}', 'null']) {
  test('usage refuses invalid settings without changing original bytes: ' + JSON.stringify(text), () => fixture(({ cfg, api }) => {
    const file = join(cfg, 'settings.json');
    writeFileSync(file, text);
    assert.throws(() => api.installUsage(), (e) => e.code === 'BAD_CONFIG' && /settings.json/.test(e.message) && /fix/i.test(e.message));
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(existsSync(file + '.bak'), false);
  }));
}

test('settings write keeps exact original backup and unrelated permissions', () => fixture(({ cfg, api }) => {
  const file = join(cfg, 'settings.json');
  const bytes = Buffer.from('{\r\n  "permissions": {"allow": ["Read"]}, "crossSessionInbound": "accept"\r\n}\r\n');
  writeFileSync(file, bytes);
  api.installUsage();
  assert.deepEqual(readFileSync(file + '.bak'), bytes);
  assert.deepEqual(JSON.parse(readFileSync(file)).permissions, { allow: ['Read'] });
}));

for (const text of ['key =\n', 'key = # missing\n', 'key = [1\n', 'key = 1]\n', 'key = "unfinished\n', 'key = \'}\'\nnext = }\n', 'mcp_servers = { magi = { command = "old" } }\n', 'mcp_servers.magi.command = "old"\n', '[ mcp_servers . magi ]\ncommand = "old"\n', 'note = """\n[mcp_servers.magi]\n"""\n', "note = '''\n[mcp_servers.magi]\n'''\n"]) {
  test('Codex install refuses unsafe TOML without mutation: ' + JSON.stringify(text), () => fixture(async ({ codex, api }) => {
    const file = join(codex, 'config.toml');
    writeFileSync(file, text);
    await assert.rejects(api.install({ codex: true, root: ROOT }), (e) => e.code === 'BAD_CONFIG' && /TOML/.test(e.message) && /\[mcp_servers.magi\]/.test(e.message));
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(existsSync(file + '.bak'), false);
  }));
}

test('Codex refuses table-like nested array lines instead of corrupting the owned table', () => fixture(async ({ codex, api }) => {
  const file = join(codex, 'config.toml');
  const before = '[mcp_servers.magi]\nargs = [\n  ["nested"],\n]\n';
  writeFileSync(file, before);
  await assert.rejects(api.install({ codex: true, root: ROOT }), { code: 'BAD_CONFIG' });
  assert.equal(readFileSync(file, 'utf8'), before);
}));

for (const target of ['claude', 'codex']) {
  test(target + '-only installation preserves omp registration and skills from existing config', () => fixture(async ({ cfg, codex, home, agent, api }) => {
    const config = join(cfg, '.claude.json');
    writeFileSync(config, JSON.stringify({ other: true, mcpServers: { magi: { command: 'node', args: ['serve', 'codex', 'omp', '--as', 'claude'] } } }));
    writeFileSync(join(codex, 'config.toml'), '[mcp_servers.magi]\nargs = ["serve", "claude", "omp", "--as", "codex"]\n');
    await api.install({ [target]: true, root: ROOT });
    const args = target === 'claude' ? JSON.parse(readFileSync(config)).mcpServers.magi.args : api.serverTable(readFileSync(join(codex, 'config.toml'), 'utf8'), 'magi');
    assert.ok(args.includes('omp'));
    assert.ok(existsSync(join(cfg, 'skills', 'peer-omp', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'peer-omp', 'SKILL.md')));
    assert.ok(existsSync(join(cfg, 'skills', 'omp-advisor', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'omp-advisor', 'SKILL.md')));
    assert.ok(existsSync(join(agent, 'extensions', 'magi', 'index.js')));
  }));
}

test('OMP installation exposes another OMP session with its own identity, binary and skill', () => fixture(async ({ agent, cli, api }) => {
  await api.install({ omp: true, root: ROOT });
  const servers = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers;
  const entry = servers['magi-omp'];
  assert.ok(entry, 'OMP callers need their own omp_peer registration');
  assert.equal(entry.args[entry.args.indexOf('serve') + 1], 'omp');
  assert.equal(entry.args[entry.args.indexOf('--as') + 1], 'omp', 'the caller must not be identified as Codex');
  assert.equal(entry.env.OMP_BIN, realpathSync(cli));
  assert.equal(entry.timeout, 0);
  const skill = join(agent, 'skills', 'peer-omp');
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), readFileSync(join(ROOT, 'skills', 'peer-omp', 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(join(skill, 'PROTOCOL.md'), 'utf8'), readFileSync(join(ROOT, 'skills', 'PROTOCOL.md'), 'utf8'));
  const rows = await api.doctorReport();
  assert.ok(rows.some((row) => row.level === 'ok' && /omp mcp.json has.*magi-omp/.test(row.text)));
  assert.ok(rows.some((row) => row.level === 'ok' && /peer-omp skill installed for omp/.test(row.text)));
  await api.uninstall();
  assert.equal(existsSync(skill), false);
}, { omp: true }));

test('Claude cmd fresh registration succeeds and preserves unrelated config with backup', () => fixture(async ({ cfg, api }) => {
  const file = join(cfg, '.claude.json');
  const before = '{"other":true,"mcpServers":{"unrelated":{"command":"keep"}}}\r\n';
  writeFileSync(file, before);
  await api.install({ claude: true, root: ROOT });
  const doc = JSON.parse(readFileSync(file));
  assert.equal(doc.mcpServers.magi.command, 'node');
  assert.deepEqual(doc.mcpServers.unrelated, { command: 'keep' });
  assert.equal(readFileSync(file + '.bak', 'utf8'), before);
}));

test('reinstall keeps env keys install does not own in the Claude and Codex magi servers', () => fixture(async ({ cfg, codex, cli, api }) => {
  const wrapper = JSON.stringify(['C:/node.exe', 'C:/loops/wrapper.mjs']);
  const file = join(cfg, '.claude.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { magi: { command: 'node', args: ['old'], env: { MAGI_WORKER_WRAPPER: wrapper, CLAUDE_BIN: 'C:/stale/claude', NOT_A_STRING: 1 } } } }));
  const toml = join(codex, 'config.toml');
  writeFileSync(toml, `[mcp_servers.magi]\ncommand = "node"\nargs = ["old"]\n\n[mcp_servers.magi.env]\nCLAUDE_BIN = "C:/stale/claude"\nMAGI_WORKER_WRAPPER = ${JSON.stringify(wrapper)}\n`);
  await api.install({ root: ROOT });
  const env = JSON.parse(readFileSync(file)).mcpServers.magi.env;
  assert.equal(env.MAGI_WORKER_WRAPPER, wrapper);
  assert.notEqual(env.CLAUDE_BIN, 'C:/stale/claude', 'install still owns the *_BIN pins');
  assert.equal('NOT_A_STRING' in env, false);
  const kept = api.tomlEnv(readFileSync(toml, 'utf8'));
  assert.equal(kept.MAGI_WORKER_WRAPPER, wrapper);
  assert.notEqual(kept.CLAUDE_BIN, 'C:/stale/claude');
  await api.install({ root: ROOT });
  assert.equal(JSON.parse(readFileSync(file)).mcpServers.magi.env.MAGI_WORKER_WRAPPER, wrapper, 'and again on the next one');
}));

test('registration failure exits nonzero, retains existing entries and never prints Done', () => fixture(({ cfg }) => {
  const file = join(cfg, '.claude.json');
  const before = '{"mcpServers":{"magi":{"command":"working-main"},"magi-omp":{"command":"working"},"other":{"command":"keep"}}}\n';
  writeFileSync(file, before);
  const out = spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'install', '--claude'], { env: process.env, encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.doesNotMatch(out.stdout, /Done\./);
  assert.match(out.stderr, /REGISTRATION_FAILED/);
  assert.equal(readFileSync(file, 'utf8'), before);
}, { failAdd: true }));

test('a CLI add that writes output then fails does not replace working registrations', () => fixture(async ({ ws, cfg, api }) => {
  writeFileSync(join(ws, 'cli.cjs'), `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'),JSON.stringify({mcpServers:{magi:{command:'node',args:process.argv.slice(process.argv.indexOf('--')+2)}}}));console.error('add failed after writing');process.exit(7);`);
  const file = join(cfg, '.claude.json');
  const before = '{"mcpServers":{"magi":{"command":"working"}}}\n';
  writeFileSync(file, before);
  await assert.rejects(api.install({ claude: true, root: ROOT }), { code: 'REGISTRATION_FAILED' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(file + '.bak'), false);
}));

test('doctor ignores a child timeout even when that table precedes the active server', () => fixture(async ({ codex, api }) => {
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.magi.env]\ntool_timeout_sec = 99999\n[mcp_servers.magi]\ntool_timeout_sec = 1\n');
  const rows = await api.doctorReport();
  assert.ok(rows.some((r) => r.level === 'fail' && /tool_timeout_sec=1\b/.test(r.text)));
}));

test('doctor checks active timeout and Claude registration without omp', () => fixture(async ({ codex, cfg, api }) => {
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.magi-omp]\ntool_timeout_sec = 99999\n[mcp_servers.magi]\ntool_timeout_sec = 1\n');
  writeFileSync(join(cfg, '.claude.json'), '{"mcpServers":{}}');
  const rows = await api.doctorReport();
  assert.ok(rows.some((r) => r.level === 'fail' && /tool_timeout_sec=1\b/.test(r.text)));
  assert.ok(rows.some((r) => r.level === 'fail' && /claude.*magi.*user/i.test(r.text)));
}));

test('doctor ignores commented headers and warns about omp version drift', () => fixture(async ({ codex, cfg, api }) => {
  writeFileSync(join(codex, 'config.toml'), '# [mcp_servers.magi]\n');
  writeFileSync(join(cfg, '.claude.json'), '{"mcpServers":{"magi":{"args":["serve","codex","omp"]}}}');
  const rows = await api.doctorReport();
  assert.ok(rows.some((r) => r.level === 'fail' && /codex config.toml has/.test(r.text)));
  assert.ok(rows.some((r) => r.level === 'ok' && /claude.*magi.*user/i.test(r.text)));
  assert.ok(rows.some((r) => r.level === 'warn' && /omp 99.0.0/.test(r.text)));
}, { omp: true }));

test('uninstall removes the Startup dashboard and Magi entries/extensions only', () => fixture(async ({ cfg, codex, agent, appdata, api }) => {
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  for (const name of ['magi-dashboard.cmd', 'keep.cmd']) writeFileSync(join(startup, name), 'keep');
  const names = ['magi', 'magi-omp', 'magi-codex'];
  const servers = Object.fromEntries([...names, 'other'].map((name) => [name, { command: name }]));
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: servers, other: true }));
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  writeFileSync(join(codex, 'config.toml'), [...names, 'other'].map((name) => `[mcp_servers.${name}]\ncommand = "${name}"\n`).join(''));
  for (const name of ['magi', 'other']) mkdirSync(join(agent, 'extensions', name), { recursive: true });
  await api.uninstall();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cfg, '.claude.json'))).mcpServers), ['other']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(agent, 'mcp.json'))).mcpServers), ['other']);
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), '[mcp_servers.other]\ncommand = "other"\n');
  assert.equal(existsSync(join(startup, 'magi-dashboard.cmd')), false);
  assert.equal(existsSync(join(startup, 'keep.cmd')), true);
  assert.equal(existsSync(join(agent, 'extensions', 'magi')), false);
  assert.equal(existsSync(join(agent, 'extensions', 'other')), true);
}));

test('install removes a stale dashboard Startup entry, says so once, and leaves other entries', () => fixture(async ({ appdata, api }) => {
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  for (const name of ['magi-dashboard.cmd', 'keep.cmd']) writeFileSync(join(startup, name), 'keep');
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  await api.install({ skillsOnly: true, root: ROOT });
  assert.equal(existsSync(join(startup, 'magi-dashboard.cmd')), false);
  assert.equal(readFileSync(join(startup, 'keep.cmd'), 'utf8'), 'keep');
  assert.equal(lines.filter((line) => /dashboard/.test(line)).length, 1);
  lines.length = 0;
  await api.install({ skillsOnly: true, root: ROOT });
  assert.deepEqual(lines.filter((line) => /dashboard/.test(line)), [], 'nothing to report once it is gone');
}));

test('quoted TOML key components are owned consistently during replacement and removal', () => fixture(async ({ codex, api }) => {
  const file = join(codex, 'config.toml');
  const before = 'model = "keep"\n["mcp_servers"."magi"]\ncommand = "old"\n["mcp_servers"."magi"."env"]\nOLD = "value"\n';
  writeFileSync(file, before);
  assert.equal(api.withoutMagiConfig(before), 'model = "keep"\n');
  await api.install({ codex: true, root: ROOT });
  const installed = readFileSync(file, 'utf8');
  assert.doesNotMatch(installed, /command = "old"|\["mcp_servers"/);
  // A key install does not own moves into the new table, once.
  assert.equal(installed.match(/^OLD = "value"$/gm)?.length, 1);
  assert.equal(api.tomlEnv(installed).OLD, 'value');
  assert.equal(readFileSync(file + '.bak', 'utf8'), before);
  assert.equal(api.withoutMagiConfig(installed).trim(), 'model = "keep"');
}));

for (const header of ['[mcp_servers."ma\\u0067i"]', '[[mcp_servers.magi]]']) {
  test('unsafe escaped or array owned TOML headers are refused: ' + header, () => fixture(async ({ codex, api }) => {
    const file = join(codex, 'config.toml');
    const before = header + '\ncommand = "working"\n';
    writeFileSync(file, before);
    await assert.rejects(api.install({ codex: true, root: ROOT }), { code: 'BAD_CONFIG' });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(file + '.bak'), false);
    assert.throws(() => api.withoutMagiConfig(before), { code: 'BAD_CONFIG' });
  }));
}

test('Claude registration merges edits made while the staged CLI is running', () => fixture(async ({ ws, cfg, api }) => {
  const file = join(cfg, '.claude.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { unrelated: { command: 'before' } }, before: true }));
  process.env.INSTALL_EDIT_TARGET = file;
  writeFileSync(join(ws, 'cli.cjs'), `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('99.0.0');process.exit(0);}if(a[0]==='plugin')process.exit(0);const live=process.env.INSTALL_EDIT_TARGET;const doc=JSON.parse(fs.readFileSync(live));doc.concurrent=true;doc.mcpServers.unrelated.command='concurrent';doc.mcpServers.added={command:'new'};fs.writeFileSync(live,JSON.stringify(doc));const at=a.indexOf('--');fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'),JSON.stringify({mcpServers:{magi:{command:a[at+1],args:a.slice(at+2)}}}));`);
  await api.install({ claude: true, root: ROOT });
  const installed = JSON.parse(readFileSync(file));
  assert.equal(installed.concurrent, true);
  assert.deepEqual(installed.mcpServers.unrelated, { command: 'concurrent' });
  assert.deepEqual(installed.mcpServers.added, { command: 'new' });
  assert.equal(installed.mcpServers.magi.command, 'node');
  const backup = JSON.parse(readFileSync(file + '.bak'));
  assert.equal(backup.concurrent, true);
  assert.deepEqual(backup.mcpServers.added, { command: 'new' });
}));

test('uninstall cleans independent owned files despite unsafe settings and reports failure', () => fixture(async ({ cfg, appdata, api }) => {
  const file = join(cfg, 'settings.json');
  const before = '{"permissions":{},}';
  writeFileSync(file, before);
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  for (const name of ['magi-dashboard.cmd', 'keep.cmd']) writeFileSync(join(startup, name), 'keep');
  await assert.rejects(api.uninstall(), { code: 'BAD_CONFIG' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(file + '.bak'), false);
  assert.equal(existsSync(join(startup, 'magi-dashboard.cmd')), false);
  assert.equal(readFileSync(join(startup, 'keep.cmd'), 'utf8'), 'keep');
}));

for (const target of ['skillsOnly', 'codex', 'claude']) {
  test(target + ' install ignores invalid configs it will not rewrite', () => fixture(async ({ cfg, codex, agent, api }) => {
    const claudeFile = join(cfg, '.claude.json');
    const ompFile = join(agent, 'mcp.json');
    const codexFile = join(codex, 'config.toml');
    const invalid = '{"unchanged":';
    writeFileSync(claudeFile, target === 'claude' ? '{"mcpServers":{}}' : invalid);
    writeFileSync(ompFile, invalid);
    writeFileSync(codexFile, target === 'codex' ? '' : 'unrelated = { inline = "keep" }\n');
    await api.install({ [target]: true, root: ROOT });
    assert.equal(readFileSync(ompFile, 'utf8'), invalid);
    assert.equal(existsSync(ompFile + '.bak'), false);
    if (target !== 'claude') assert.equal(readFileSync(claudeFile, 'utf8'), invalid);
    if (target !== 'codex') assert.equal(readFileSync(codexFile, 'utf8'), 'unrelated = { inline = "keep" }\n');
    assert.ok(existsSync(join(cfg, 'skills', 'peer-codex', 'SKILL.md')));
    if (target === 'claude') assert.equal(JSON.parse(readFileSync(claudeFile)).mcpServers.magi.command, 'node');
    if (target === 'codex') assert.match(readFileSync(codexFile, 'utf8'), /\[mcp_servers.magi\]/);
  }));
}

for (const target of ['claude', 'codex']) {
  test(target + ' migration preserves magi-omp support without an omp binary', () => fixture(async ({ cfg, codex, home, agent, api }) => {
    const claudeFile = join(cfg, '.claude.json');
    const codexFile = join(codex, 'config.toml');
    if (target === 'claude') writeFileSync(claudeFile, '{"mcpServers":{"magi-omp":{"command":"node"}}}');
    else writeFileSync(codexFile, '[mcp_servers.magi-omp]\ncommand = "node"\n');
    await api.install({ [target]: true, root: ROOT });
    if (target === 'claude') {
      const servers = JSON.parse(readFileSync(claudeFile)).mcpServers;
      assert.ok(servers.magi.args.includes('omp'));
      assert.equal(servers['magi-omp'], undefined);
    } else {
      const installed = readFileSync(codexFile, 'utf8');
      assert.match(api.serverTable(installed, 'magi'), /"omp"/);
      assert.doesNotMatch(installed, /\[mcp_servers.magi-omp\]/);
    }
    assert.ok(existsSync(join(cfg, 'skills', 'peer-omp', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'peer-omp', 'SKILL.md')));
    assert.ok(existsSync(join(agent, 'extensions', 'magi', 'index.js')));
  }));
}

test('doctor checks database integrity and diagnoses raw stale state without sweeping it', () => fixture(async ({ api }) => {
  const { database, setRecord, listRecords } = await import('../src/store.mjs');
  const { openRound, recordClarify, closeRound } = await import('../src/state.mjs');
  const db = database(process.env.MAGI_HOME);
  const now = Date.now();
  const deadPid = 2147483647;
  db.prepare('INSERT INTO waiters(id,task_id,round,pid,deadline) VALUES(?,?,?,?,?)').run('dead', 'old', 1, deadPid, now + 1000);
  db.prepare('INSERT INTO waiters(id,task_id,round,pid,deadline) VALUES(?,?,?,?,?)').run('live', 'old', 1, process.pid, now + 1000);
  setRecord(process.env.MAGI_HOME, 'workers', 'dead', { taskId: 'dead', pid: deadPid, startedAt: now, timeoutMs: 10000 });
  setRecord(process.env.MAGI_HOME, 'workers', 'overdue', { taskId: 'overdue', pid: process.pid, startedAt: now - 20000, timeoutMs: 10000 });
  setRecord(process.env.MAGI_HOME, 'workers', 'live', { taskId: 'live', pid: process.pid, startedAt: now, timeoutMs: 10000 });
  openRound({ taskId: 'old', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1 });
  const questionId = recordClarify({ taskId: 'old', from: 'codex', body: 'Need input' });
  db.prepare("UPDATE questions SET value=json_set(value,'$.askedAt',?) WHERE id=?").run(now - 86400001, questionId);
  const rows = await api.doctorReport();
  assert.ok(rows.some((row) => row.level === 'ok' && /quick_check ok/.test(row.text)));
  assert.ok(rows.some((row) => row.level === 'fail' && /stuck waiters.*: 1;.*magi sweep/.test(row.text)));
  assert.ok(rows.some((row) => row.level === 'fail' && /stuck workers.*: 2;.*restart.*magi sweep/.test(row.text)));
  assert.ok(rows.some((row) => row.level === 'fail' && /open questions.*: 1;.*magi close --task old/.test(row.text)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waiters').get().n, 2);
  assert.equal(listRecords(process.env.MAGI_HOME, 'workers').length, 3);
  closeRound({ taskId: 'old', round: 1, reason: 'abandoned' });
  assert.ok((await api.doctorReport()).some((row) => row.level === 'ok' && /open questions.*: 0/.test(row.text)));
}));

test('doctor reports a corrupt magi.db instead of failing while reading provider settings', () => fixture(async ({ api }) => {
  mkdirSync(process.env.MAGI_HOME, { recursive: true });
  writeFileSync(join(process.env.MAGI_HOME, 'magi.db'), 'not a SQLite database');
  const rows = await api.doctorReport();
  assert.ok(rows.some((row) => row.level === 'fail' && /database health:.*restore magi.db.*magi doctor/.test(row.text)));
}));

// fnm's layout, inside the workspace: a per-shell folder linking to the
// installed node, whose bin/codex links to the package's script. Windows
// without the symlink privilege gets the folder link (a junction) alone.
function shellLinked(ws) {
  const install = join(ws, 'fnm', 'installation');
  const script = join(install, 'lib', 'codex', 'codex.js');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "console.log('codex-cli 0.0.1');\n");
  mkdirSync(join(install, 'bin'));
  let rel = join('lib', 'codex', 'codex.js');
  try {
    symlinkSync(join('..', 'lib', 'codex', 'codex.js'), join(install, 'bin', 'codex'));
    rel = join('bin', 'codex');
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
  }
  const shells = join(ws, 'run', 'fnm_multishells');
  mkdirSync(shells, { recursive: true });
  symlinkSync(install, join(shells, '42_1'), 'junction');
  return { link: join(shells, '42_1', rel), real: realpathSync(script) };
}

test('per-shell roots: fnm on any OS, XDG_RUNTIME_DIR, /run/user', () => fixture(({ api }) => {
  assert.equal(api.ephemeralRoot('/run/user/1000/fnm_multishells/27256_1/bin/codex', {}), '/run/user/1000/fnm_multishells');
  assert.equal(api.ephemeralRoot('C:\\Users\\h\\AppData\\Local\\fnm_multishells\\1_2\\codex.cmd', {}), 'C:\\Users\\h\\AppData\\Local\\fnm_multishells');
  assert.equal(api.ephemeralRoot('/tmp/xdg/bin/codex', { XDG_RUNTIME_DIR: '/tmp/xdg/' }), '/tmp/xdg');
  assert.equal(api.ephemeralRoot('/run/user/1000/bin/codex', {}), '/run/user/1000');
  assert.equal(api.ephemeralRoot('/home/h/.local/bin/claude', { XDG_RUNTIME_DIR: '/run/user/1000' }), null);
}));

test('install records the file behind a per-shell link in all three configs', () => fixture(async ({ ws, cfg, codex, agent, api }) => {
  const { link, real } = shellLinked(ws);
  process.env.CODEX_BIN = link;
  await api.install({ omp: true, root: ROOT });
  assert.equal(JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')).mcpServers.magi.env.CODEX_BIN, real);
  assert.ok(readFileSync(join(codex, 'config.toml'), 'utf8').includes(`CODEX_BIN = ${JSON.stringify(real)}`));
  const omp = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers;
  assert.equal(omp.magi.env.CODEX_BIN, real);
  assert.equal(omp['magi-codex'].env.CODEX_BIN, real);
  assert.ok(!api.configuredBins().some(({ value }) => value.includes('fnm_multishells')));
}, { omp: true }));

test('--usage beside --omp does both; alone it touches only the statusline', () => fixture(async ({ cfg, agent, api }) => {
  await api.install({ usage: true, root: ROOT });
  assert.equal(existsSync(join(agent, 'mcp.json')), false, 'usage alone registers nothing');
  assert.equal(JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8')).statusLine.command, api.STATUSLINE_COMMAND);
  rmSync(join(cfg, 'settings.json'));
  await api.install({ omp: true, usage: true, root: ROOT });
  assert.ok(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.magi);
  assert.equal(JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8')).statusLine.command, api.STATUSLINE_COMMAND);
}, { omp: true }));

test('a link outside per-shell folders is recorded as the link, not the versioned file behind it', { skip: isWin && 'file symlinks need a privilege on Windows' }, () => fixture(({ ws, api }) => {
  const file = join(ws, 'versions', '2.1.289');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  const link = join(ws, 'local-bin', 'claude');
  mkdirSync(dirname(link));
  symlinkSync(file, link);
  assert.equal(api.stableBin('claude', link, { env: {} }), link);
}));

test('install refuses a CLI that exists only inside a per-shell folder and writes no config', () => fixture(async ({ ws, cfg, codex, api }) => {
  const bin = join(ws, 'run', 'fnm_multishells', '7_1', 'bin', 'codex.js');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '\n');
  process.env.CODEX_BIN = bin;
  const toml = '[other]\nx = 1\n';
  const claude = '{"mcpServers":{}}\n';
  writeFileSync(join(codex, 'config.toml'), toml);
  writeFileSync(join(cfg, '.claude.json'), claude);
  await assert.rejects(api.install({ root: ROOT }), (e) => e.code === 'EPHEMERAL_BIN' && /CODEX_BIN/.test(e.message) &&
    /fnm_multishells/.test(e.message) && /per-shell folder/.test(e.message) && /re-run install/.test(e.message));
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), toml);
  assert.equal(readFileSync(join(cfg, '.claude.json'), 'utf8'), claude);
}));

test('doctor fails a configured CLI path that is missing or per-shell, and passes stable ones', () => fixture(async ({ ws, cfg, codex, agent, cli, api }) => {
  const shell = join(ws, 'run', 'fnm_multishells', '9_1', 'codex');
  mkdirSync(dirname(shell), { recursive: true });
  writeFileSync(shell, '\n');
  const missing = join(ws, 'gone', 'codex');
  const write = (claudeCodex, codexCodex) => {
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { magi: { command: 'node', args: [], env: { CLAUDE_BIN: cli, CODEX_BIN: claudeCodex } } } }));
    writeFileSync(join(codex, 'config.toml'), `[mcp_servers.magi]\ncommand = "node"\n\n[mcp_servers.magi.env]\nCODEX_BIN = ${JSON.stringify(codexCodex)}\n`);
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { magi: { env: { CLAUDE_BIN: cli } } } }));
  };
  write(shell, missing);
  let fails = (await api.doctorReport()).filter((r) => r.level === 'fail' && /_BIN in /.test(r.text));
  assert.equal(fails.length, 2);
  assert.ok(fails.some((r) => r.text.includes(shell) && /per-shell folder/.test(r.text) && /magi install/.test(r.text)));
  assert.ok(fails.some((r) => r.text.includes(missing) && /does not exist/.test(r.text) && /config\.toml/.test(r.text)));
  write(cli, cli);
  const rows = await api.doctorReport();
  assert.ok(rows.some((r) => r.level === 'ok' && /configured CLI paths: 4, all present/.test(r.text)));
  assert.ok(!rows.some((r) => /_BIN in /.test(r.text)));
}));

test('doctor reports only the dialog timeout, with precedence, expiry semantics and no invented warning threshold', () => fixture(async ({ cfg, api }) => {
  const { setProvider } = await import('../src/providers.mjs');
  setProvider('codex', false);
  setProvider('omp', false);
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { magi: { command: process.execPath, args: [] } } }));
  const key = 'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS';
  const file = join(cfg, 'settings.json');
  const secret = 'DO_NOT_PRINT_OTHER_ENV_VALUE';
  const read = async () => {
    const rows = await api.doctorReport();
    const matches = rows.filter((row) => row.text.startsWith(key + ':'));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].level, 'info');
    assert.equal(rows.some((row) => row.text.includes(secret)), false);
    return matches[0].text;
  };
  delete process.env[key];
  writeFileSync(file, JSON.stringify({ crossSessionInbound: 'accept', env: { OTHER_PRIVATE_VALUE: secret } }));
  let row = await read();
  assert.match(row, /300000 ms.*source: Claude default/);
  assert.match(row, /held PEER message.*dropped after 5 min unless approved/);
  const printed = [];
  const print = console.log;
  console.log = (line) => printed.push(String(line));
  try { assert.equal(await api.doctor(), true, 'an informational timeout and version warning do not fail a healthy doctor'); }
  finally { console.log = print; }
  assert.ok(printed.some((line) => /^\s*info\s+CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: 300000 ms/.test(line)));
  assert.equal(printed.some((line) => line.includes(secret)), false);
  writeFileSync(file, JSON.stringify({ crossSessionInbound: 'accept', dialogExpiry: '10m', env: { OTHER_PRIVATE_VALUE: secret } }));
  assert.match(await read(), /600000 ms.*source: user settings\.json dialogExpiry/);
  writeFileSync(file, JSON.stringify({ crossSessionInbound: 'accept', dialogExpiry: '10m', env: { [key]: '120000', OTHER_PRIVATE_VALUE: secret } }));
  assert.match(await read(), /120000 ms.*source: user settings\.json env/);
  process.env[key] = '60000';
  assert.match(await read(), /60000 ms.*source: Magi process environment.*after 1 min/);
  process.env[key] = '1';
  assert.match(await read(), /1 ms/); // No evidence-backed warning threshold.
  process.env[key] = '0';
  assert.match(await read(), /0 ms.*no expiry deadline/);
  process.env[key] = secret + '\nOTHER_SECRET=value';
  assert.match(await read(), /effective timeout unknown.*value withheld/);
  delete process.env[key];
  writeFileSync(file, '{ broken settings');
  assert.match(await read(), /effective timeout unknown.*settings\.json unreadable/);
}));
