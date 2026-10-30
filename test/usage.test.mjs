// What a headless run cost reaches the ledger and the log; subscription
// usage comes from Codex's app-server and Claude's statusline JSON. The
// fixtures are the shapes the real CLIs printed on 2026-09-14: claude
// 2.1.263 (`-p --output-format json`, statusline input) and codex-cli
// 0.153.4 (`account/rateLimits/read`). A headless Codex run's own usage is
// read by its app-server session (test/headless-notes.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseClaudeJson } from '../src/exec.mjs';
import { parseOmpJsonl } from '../src/omp-launch.mjs';
import { makeWorkspace, ROOT } from './helpers/harness.mjs';
import { getRecord } from '../src/store.mjs';

const CLI = join(ROOT, 'bin', 'magi.mjs');

test('the Claude parser reads cost, tokens, duration, turns and model out of the result envelope', () => {
  const r = parseClaudeJson(JSON.stringify({
    result: 'ok',
    session_id: 's1',
    total_cost_usd: 0.1234,
    duration_ms: 5100,
    num_turns: 3,
    usage: { input_tokens: 12, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800, output_tokens: 250 },
    modelUsage: { 'claude-opus-5': { inputTokens: 12 } },
  }));
  assert.deepEqual(r.usage, { costUsd: 0.1234, inputTokens: 40812, outputTokens: 250, durationMs: 5100, turns: 3, model: 'claude-opus-5' });
  assert.equal(parseClaudeJson(JSON.stringify({ result: 'ok' })).usage, undefined);
});

test('the omp parser takes usage only when a message carries it', () => {
  const with_ = parseOmpJsonl('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":100,"output":5,"cost":{"total":0.002}}}}');
  assert.deepEqual(with_.usage, { costUsd: 0.002, inputTokens: 100, outputTokens: 5 });
  assert.equal(parseOmpJsonl('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}').usage, undefined);
});

test('omp usage is the sum over its messages, and a total of zero is unpriced rather than free', () => {
  const msg = (u) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } });
  const run = parseOmpJsonl([
    msg({ input: 1000, output: 100, cacheRead: 50000, cacheWrite: 0, cost: { total: 0.0085 } }),
    msg({ input: 300, output: 50, cacheRead: 51000, cost: { total: 0.0004 } }),
  ].join('\n'));
  assert.equal(run.usage.inputTokens, 1000 + 50000 + 300 + 51000);
  assert.equal(run.usage.outputTokens, 150);
  assert.ok(Math.abs(run.usage.costUsd - 0.0089) < 1e-9);
  const unpriced = parseOmpJsonl(msg({ input: 10, output: 2, cost: { total: 0 } }));
  assert.deepEqual(unpriced.usage, { costUsd: null, inputTokens: 10, outputTokens: 2 });
});

test('a headless reply records how it was answered and what it cost, and the log adds it up', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  mkdirSync(home, { recursive: true });
  process.env.MAGI_HOME = home;
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const { readTask } = await import('../src/state.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => { throw new Error('unused'); },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfine', via: 'headless', usage: { costUsd: 0.25, inputTokens: 1000, outputTokens: 50 } }),
  });
  const res = await engine.handleRequest({ wait: true, task: 'x', workingDirectory: ws });
  const rec = readTask(res.structuredContent.taskId);
  assert.equal(rec.rounds[0].via, 'headless');
  assert.equal(rec.rounds[0].usage.costUsd, 0.25);
  const log = execFileSync(process.execPath, [CLI, 'log'], { env: { ...process.env, MAGI_HOME: home }, encoding: 'utf-8' });
  assert.match(log, /\$0\.25/);
  assert.match(log, /peer spend \$0\.25 over 1 priced headless run/);
});

// The statusline JSON as claude 2.1.263 documents it.
const STATUSLINE = {
  session_id: '11111111-2222-4333-8444-555555555555',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
  cost: { total_cost_usd: 1.5 },
  rate_limits: { five_hour: { used_percentage: 37, resets_at: 1789440000 }, seven_day: { used_percentage: 61, resets_at: 1789900000 } },
  prompt_cache: { warm: true },
};

test('the statusline hook records the JSON per session, chains the user\'s own statusline, and renders a line without one', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  mkdirSync(home, { recursive: true });
  process.env.MAGI_HOME = home;
  const usage = await import('../src/usage.mjs?' + Math.random());
  const line = await usage.runStatusline(JSON.stringify(STATUSLINE), { chain: null });
  assert.equal(line, 'Opus 5 · ctx 42% · 5h 37% · 7d 61% · warm');
  const rec = getRecord(home, 'usage-claude', STATUSLINE.session_id);
  assert.equal(rec.rateLimits.seven_day.used_percentage, 61);
  assert.deepEqual(usage.claudeUsage().windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [['5h', 37, 1789440000000], ['7d', 61, 1789900000000]]);
  const st = usage.claudeSessionStatus(STATUSLINE.session_id);
  assert.deepEqual([st.contextPercent, st.contextTokens, st.contextSize, st.costUsd, st.cacheWarm, st.model], [42, 84000, 200000, 1.5, true, 'claude-opus-5']);
  assert.equal(usage.claudeSessionStatus('nope'), null);

  // Chained: the original statusline gets the same stdin and its output is what shows.
  const chained = await usage.runStatusline(JSON.stringify(STATUSLINE), { chain: { command: `"${process.execPath}" -e "process.stdin.on('data',d=>process.stdout.write('mine:'+JSON.parse(d).model.id))"` } });
  assert.equal(chained, 'mine:claude-opus-5');
  // Garbage in: nothing recorded, nothing rendered, nothing thrown.
  assert.equal(await usage.runStatusline('not json', { chain: null }), '');
});

test('Codex rate limits normalise to windows with a label, a percentage and a reset time', async () => {
  const { normaliseCodexRateLimits } = await import('../src/usage.mjs');
  const u = normaliseCodexRateLimits({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1789817669 }, secondary: null, credits: { hasCredits: false }, planType: 'pro' },
    rateLimitsByLimitId: { codex: {}, codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 0, resetsAt: null } } },
  });
  assert.equal(u.plan, 'pro');
  assert.deepEqual(u.windows, [{ label: '7d', usedPercent: 99, windowMinutes: 10080, resetsAt: 1789817669000 }]);
  assert.deepEqual(u.byModel, [{ id: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', usedPercent: 0, resetsAt: null }]);
  assert.equal(normaliseCodexRateLimits(null), null);
});

test('install --usage chains the existing statusLine and uninstall restores it', async () => {
  const ws = makeWorkspace();
  const cfg = join(ws, 'claude-cfg');
  mkdirSync(cfg, { recursive: true });
  process.env.MAGI_HOME = join(ws, 'home');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-statusline.sh' }, other: 1 }));
  const { installUsage, uninstallUsage, STATUSLINE_COMMAND } = await import('../src/install.mjs?' + Math.random());
  const { readChain } = await import('../src/usage.mjs?' + Math.random());
  const orig = console.log;
  console.log = () => {};
  try {
    installUsage();
    let doc = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'));
    assert.equal(doc.statusLine.command, STATUSLINE_COMMAND);
    assert.equal(doc.other, 1);
    assert.deepEqual(readChain(), { command: 'my-statusline.sh' });
    installUsage(); // idempotent: does not chain itself
    assert.deepEqual(readChain(), { command: 'my-statusline.sh' });
    uninstallUsage();
    doc = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'));
    assert.equal(doc.statusLine.command, 'my-statusline.sh');
    assert.equal(readChain(), null);
  } finally {
    console.log = orig;
  }
});
