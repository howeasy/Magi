// Claude or Codex consulting an Oh My Pi session through omp_peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf, initGitRepo } from './helpers/harness.mjs';
import { getRecord, setRecord, statement } from '../src/store.mjs';
import * as state from '../src/state.mjs';
import { processStartedAt } from '../omp/process-identity.js';

function registerOmp(home, { pid = process.pid, cwd = process.cwd(), name = 'omp-main', sessionFile = null } = {}) {
  const rec = { agent: 'omp', pid, processStartedAt: processStartedAt(pid), sessionId: 'omp-sess-1', name, sessionFile, cwd, startedAt: Date.now() };
  setRecord(home, 'agents', String(pid), rec);
  return rec;
}

test('Claude consults a headless omp: rpc mode, read-only flags, prompt as a command, PEER_DEPTH, parsed reply', async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'claude' } });
  let res;
  try {
    res = await s.call('omp_peer', { wait: true, task: 'Review the change', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, diffRef: 'HEAD~1..HEAD' });
    assert.equal(res.isError, undefined, textOf(res));
  } finally {
    await s.close();
  }
  assert.equal(res.structuredContent.sections.summary, 'Fake peer reply.');
  assert.match(textOf(res), /via=headless diff_sha256=[0-9a-f]{64} thread_id=omp-sess-fake/);
  const call = readCalls(logFile)[0];
  const argv = call.args.join(' ');
  assert.match(argv, /^--mode rpc --no-ui --no-extensions --no-skills --no-title --cwd /);
  assert.match(argv, /--tools read,grep,glob,web_search --approval-mode always-ask/);
  assert.ok(!argv.includes('--approval-mode write'));
  assert.equal(call.env.PEER_DEPTH, '1');
  assert.match(call.stdin, /orchestrator=claude/);
  assert.match(call.stdin, /peer=omp/);
  assert.match(call.stdin, /Respond inline/, 'a headless peer has no bridge tool to call');
  const rec = getRecord(env.MAGI_HOME, 'tasks', res.structuredContent.taskId);
  assert.deepEqual([rec.orchestrator, rec.peer], ['claude', 'omp']);
});

test('a standalone omp server recognizes its registered OMP caller instead of claiming Codex', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  registerOmp(env.MAGI_HOME, { cwd: ws });
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: '' } });
  try {
    const result = await s.call('omp_peer', { task: 'Identify this conversation', delivery: 'headless', wait: true, workingDirectory: ws });
    assert.equal(result.isError, undefined, textOf(result));
    const card = getRecord(env.MAGI_HOME, 'tasks', result.structuredContent.taskId);
    assert.equal(card.orchestrator, 'omp');
    assert.equal(card.orchestratorTarget.sessionId, 'omp-sess-1');
    assert.equal(card.peer, 'omp');
    assert.match(readCalls(logFile)[0].stdin, /orchestrator=omp\b/);
  } finally {
    await s.close();
  }
});

test('a delegated headless omp may write, and a resumed one keeps its session id', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'codex' } });
  try {
    const res = await s.call('omp_peer', { wait: true, task: 'Add the test', mode: 'DELEGATE', delivery: 'headless', allowWrites: true, resumeThreadId: 'omp-prev', workingDirectory: ws });
    assert.equal(res.isError, undefined, textOf(res));
  } finally {
    await s.close();
  }
  const argv = readCalls(logFile)[0].args.join(' ');
  assert.match(argv, /--resume omp-prev/);
  assert.match(argv, /--approval-mode write/);
  assert.ok(!argv.includes('--tools'));
});

test('a live omp session gets the request in its inbox, aside by default and steer on request', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;
  // Backslashes and case differ from how the orchestrator spells the cwd.
  registerOmp(home, { cwd: ws.replace(/\//g, '\\').toUpperCase() });

  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'claude' } });
  let taskId;
  try {
    const peers = await s.call('omp_peer', { kind: 'peers', workingDirectory: ws });
    assert.match(textOf(peers), /omp-main.*\[omp-sess-1\]/s);
    assert.match(textOf(peers), /would go to "omp-main"/);

    const res = await s.call('omp_peer', { wait: true, task: 'Review', mode: 'REVIEW', wait: false, workingDirectory: ws });
    assert.equal(res.isError, undefined, textOf(res));
    assert.match(textOf(res), /Sent to omp \(live:omp-main\)/);
    taskId = res.structuredContent.taskId;

    const note = await s.call('omp_peer', { kind: 'note', body: 'heads up', delivery: 'steer', workingDirectory: ws });
    assert.equal(note.isError, undefined, textOf(note));
  } finally {
    await s.close();
  }
  const frames = statement(home, 'SELECT body FROM frames WHERE to_pid=? ORDER BY created_at,id').all(process.pid).map((row) => JSON.parse(row.body));
  assert.equal(frames.length, 2);
  assert.match(frames[0].text, new RegExp(`^PEER REQUEST magi/1 task_id=${taskId} orchestrator=claude`));
  assert.match(frames[0].text, /using the claude_peer tool with kind="reply"/, 'the omp peer answers with its own bridge tool');
  assert.equal(frames[0].deliverAs, 'aside');
  assert.match(frames[1].text, /^PEER NOTE magi\/1 from=claude/);
  assert.equal(frames[1].deliverAs, 'steer');
  const rec = getRecord(home, 'tasks', taskId);
  assert.equal(rec.peer, 'omp');
  assert.equal(rec.peerTarget.pid, process.pid);
});

test('with no live omp, live is refused with the sessions elsewhere named, and auto falls back to headless', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env } = fakeEnv(ws);
  registerOmp(env.MAGI_HOME, { cwd: 'E:/somewhere/else', name: 'other' });
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'claude' } });
  try {
    const live = await s.call('omp_peer', { wait: true, task: 'x', delivery: 'live', workingDirectory: ws });
    assert.equal(live.isError, true);
    assert.match(textOf(live), /NO_LIVE_PEER.*other in E:\/somewhere\/else/);
    const auto = await s.call('omp_peer', { wait: true, task: 'x', workingDirectory: ws });
    assert.equal(auto.isError, undefined, textOf(auto));
    assert.match(textOf(auto), /via=headless/);
  } finally {
    await s.close();
  }
});

test('omp replies to a Claude-orchestrated task through its own claude_peer, and the ledger accepts omp as the peer', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['claude', 'omp']);
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;
  process.env.MAGI_HOME = home;
  registerOmp(home);
  setRecord(home, 'tasks', 'cx-toomp', {
    taskId: 'cx-toomp', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, replyTo: null, orchestratorTarget: null, cwd: ws,
    rounds: [{ round: 1, openedAt: Date.now(), replied: false, clarifies: 0 }],
  });
  // omp's claude_peer server runs --as omp; it is the omp session's tool.
  const omp = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude, MAGI_AS: 'omp' } });
  try {
    const res = await omp.call('claude_peer', { kind: 'reply', taskId: 'cx-toomp', body: 'SUMMARY\nlooks fine\n' });
    // No Claude session is live here, so the route fails and the reply is retained.
    assert.match(textOf(res), /NO_REPLY_ROUTE.*left in the mailbox/);
    const rec = getRecord(home, 'tasks', 'cx-toomp');
    assert.equal(rec.rounds[0].replied, true, 'the ledger recorded omp as the answering peer');
    assert.equal(state.listMail('cx-toomp').some((reply) => reply.round === 1), true);

    const again = await omp.call('claude_peer', { kind: 'reply', taskId: 'cx-toomp', body: 'twice' });
    assert.match(textOf(again), /ALREADY_REPLIED/);
  } finally {
    await omp.close();
  }
});

test('parseOmpJsonl reads the header and the last assistant message, and flags a failed turn', async () => {
  const { parseOmpJsonl, ompSessionPurpose, headlessOmpArgs } = await import('../src/omp-launch.mjs');
  const line = (o) => JSON.stringify(o);
  const ok = parseOmpJsonl([
    line({ type: 'session', id: 'abc', cwd: 'x' }),
    line({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }),
    line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'toolUse' } }),
    'not json at all',
    line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'final' }], stopReason: 'stop' } }),
  ].join('\n'));
  assert.deepEqual(ok, { message: 'final', sessionId: 'abc', errors: [] });

  const bad = parseOmpJsonl(line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 model retired' } }));
  assert.deepEqual(bad.errors, ['404 model retired']);
  assert.equal(bad.message, '');

  const ws = makeWorkspace();
  const file = join(ws, 'sess.jsonl');
  writeFileSync(file, [line({ type: 'title', title: 'Fix exit path' }), line({ type: 'session', id: 's', cwd: ws }), line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Parser exit path is broken.\nFix it.' }] } })].join('\n'));
  assert.equal(ompSessionPurpose({ sessionFile: file }), 'Fix exit path: Parser exit path is broken.');
  assert.equal(ompSessionPurpose({ sessionFile: join(ws, 'missing.jsonl') }), null);

  assert.ok(!headlessOmpArgs({ allowWrites: true }).includes('--tools'));
  const m = headlessOmpArgs({ model: 'openai/gpt-5.2' });
  assert.equal(m[m.indexOf('--model') + 1], 'openai/gpt-5.2');
  assert.ok(headlessOmpArgs().includes('--no-extensions'));
});

test('the Codex magi server also serves omp only when asked (no second table), and uninstall strips an old magi-omp too', async () => {
  const { tomlSection, withoutMagiConfig, magiConfigSection } = await import('../src/install.mjs');
  const bins = { CLAUDE_BIN: 'C:/c.exe', CODEX_BIN: null, OMP_BIN: 'C:/omp.exe' };
  const plain = tomlSection({ omp: false, bins });
  assert.ok(!plain.includes('magi-omp'));
  const both = tomlSection({ omp: true, bins });
  assert.match(both, /\[mcp_servers\.magi\]\ncommand = "node"\nargs = \[.*"serve", "claude", "omp", "--as", "codex"\]/);
  assert.ok(!both.includes('magi-omp'), 'one server, not two');
  assert.match(both, /\[mcp_servers\.magi\.env\]\nCLAUDE_BIN = "C:\/c.exe"\nOMP_BIN = "C:\/omp.exe"/);
  const user = '[model]\nname = "x"\n\n' + both + '\n[other]\nk = 1\n';
  assert.equal(withoutMagiConfig(user), '[model]\nname = "x"\n\n[other]\nk = 1\n');
  // An install from before the merge left a second table; reinstall strips it.
  const old = '[model]\nname = "x"\n\n[mcp_servers.magi-omp]\ncommand = "node"\nargs = ["m", "serve", "omp", "--as", "codex"]\n\n[other]\nk = 1\n';
  assert.match(magiConfigSection(old), /magi-omp/);
  assert.equal(withoutMagiConfig(old), '[model]\nname = "x"\n\n[other]\nk = 1\n');
});

test('install places the one PROTOCOL.md beside every installed skill, and the repo keeps no copies', async () => {
  const home = join(makeWorkspace(), 'home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, OMP_AGENT_DIR: process.env.OMP_AGENT_DIR };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), OMP_AGENT_DIR: join(home, '.omp', 'agent') });
  try {
    const { install } = await import('../src/install.mjs');
    const { ROOT } = await import('./helpers/harness.mjs');
    await install({ omp: true, skillsOnly: true, root: ROOT });
    const protocol = readFileSync(join(ROOT, 'skills', 'PROTOCOL.md'), 'utf-8');
    for (const dir of [
      join(home, '.claude', 'skills', 'peer-codex'), join(home, '.claude', 'skills', 'peer-omp'), join(home, '.claude', 'skills', 'omp-advisor'),
      join(home, '.agents', 'skills', 'peer-claude'), join(home, '.agents', 'skills', 'peer-omp'), join(home, '.agents', 'skills', 'omp-advisor'),
      join(home, '.omp', 'agent', 'skills', 'peer-claude'), join(home, '.omp', 'agent', 'skills', 'peer-codex'),
    ]) {
      assert.equal(existsSync(join(dir, 'SKILL.md')), true, dir);
      assert.equal(readFileSync(join(dir, 'PROTOCOL.md'), 'utf-8'), protocol, dir);
    }
    for (const skill of ['peer-codex', 'peer-claude', 'peer-omp', 'omp-advisor']) {
      assert.equal(existsSync(join(ROOT, 'skills', skill, 'PROTOCOL.md')), false, 'the repo keeps a single PROTOCOL.md');
    }
    // omp's own skills are for consulting the other two; the advisor skill is for their orchestrators.
    assert.equal(existsSync(join(home, '.omp', 'agent', 'skills', 'omp-advisor')), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
