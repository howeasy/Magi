// Subscription usage, the unit that matters when nobody pays per token.
//
// Codex: the app-server answers `account/rateLimits/read` with the plan and
// its rolling windows (0.153.4: primary 7-day window as usedPercent,
// windowDurationMins, resetsAt, plus a per-model breakdown). Read live,
// cached a minute.
//
// Claude Code: the statusline command is handed JSON on every render with
// `rate_limits.five_hour` / `seven_day` {used_percentage, resets_at},
// `context_window`, `cost`, `model` and `prompt_cache.warm` (2.1.263; the
// schema is documented in the binary's statusline help). `magi install
// --usage` chains `magi statusline` in front of whatever statusline the
// user has, and it writes that JSON to the usage-claude database namespace.
// Account-level windows come from the newest row; per-session context,
// cost and cache warmth from each session's own.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { magiHome } from './state.mjs';
import { getRecord, setRecord, transaction, listRecords } from './store.mjs';
import { appServer } from './transport.mjs';

const CODEX_TTL_MS = 60_000;
// A status older than this belongs to a session that is gone or has not
// rendered in a while; its windows are stale, its warmth unknown.
const CLAUDE_FRESH_MS = 10 * 60_000;

const legacyByHome = new Map();
function legacyState() {
  const home = magiHome();
  if (legacyByHome.has(home)) return legacyByHome.get(home);
  const value = { statuses: new Map(), chain: null };
  const root = join(home, 'usage', 'claude');
  if (existsSync(root)) for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    try { value.statuses.set(name.slice(0, -5), JSON.parse(readFileSync(join(root, name), 'utf8'))); } catch { /* Explicit migrate reports corrupt legacy files. */ }
  }
  try { value.chain = JSON.parse(readFileSync(join(home, 'statusline-chain.json'), 'utf8')); } catch { /* No legacy chain. */ }
  legacyByHome.set(home, value);
  return value;
}

// --- Codex ------------------------------------------------------------------

let codexCache = { at: 0, value: null };

export function normaliseCodexRateLimits(r) {
  if (!r?.rateLimits) return null;
  const window = (w, label) => (w ? { label, usedPercent: w.usedPercent ?? w.used_percent ?? null, windowMinutes: w.windowDurationMins ?? w.window_minutes ?? null, resetsAt: (w.resetsAt ?? w.resets_at ?? null) && (w.resetsAt ?? w.resets_at) * 1000 } : null);
  const top = r.rateLimits;
  const windows = [window(top.primary, top.primary?.windowDurationMins === 300 ? '5h' : top.primary?.windowDurationMins === 10080 ? '7d' : `${top.primary?.windowDurationMins ?? '?'}m`), window(top.secondary, 'secondary')].filter(Boolean);
  const byModel = Object.entries(r.rateLimitsByLimitId ?? {})
    .filter(([id]) => id !== top.limitId)
    .map(([id, v]) => ({ id, name: v.limitName ?? id, usedPercent: v.primary?.usedPercent ?? null, resetsAt: v.primary?.resetsAt ? v.primary.resetsAt * 1000 : null }));
  return { plan: top.planType ?? null, windows, byModel, credits: top.credits ?? null, at: Date.now() };
}

export async function codexUsage() {
  if (codexCache.value && Date.now() - codexCache.at < CODEX_TTL_MS) return codexCache.value;
  let value;
  try {
    const [res] = await appServer([{ method: 'account/rateLimits/read', params: {} }], { timeoutMs: 15_000 });
    value = res?.error ? { error: JSON.stringify(res.error) } : normaliseCodexRateLimits(res?.result);
  } catch (e) {
    value = { error: e.code ?? e.message };
  }
  codexCache = { at: Date.now(), value };
  return value;
}

// --- Claude ------------------------------------------------------------------

// What the statusline hook keeps per session, from the JSON Claude hands it.
export function recordClaudeStatus(json) {
  const id = json?.session_id;
  if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) return null;
  const rec = {
    sessionId: id,
    at: Date.now(),
    model: json.model?.id ?? json.model?.display_name ?? null,
    contextWindow: json.context_window ?? null,
    cost: json.cost ?? null,
    rateLimits: json.rate_limits ?? null,
    promptCache: json.prompt_cache ?? null,
  };
  transaction(magiHome(), () => setRecord(magiHome(), 'usage-claude', id, rec));
  return rec;
}

function readClaudeStatuses() {
  const statuses = new Map(legacyState().statuses);
  for (const rec of listRecords(magiHome(), 'usage-claude')) statuses.set(rec.sessionId, rec);
  return [...statuses.values()].sort((a, b) => b.at - a.at);
}

// The account's windows, from whichever session rendered most recently.
export function claudeUsage() {
  const fresh = readClaudeStatuses().find((r) => r.rateLimits && Date.now() - r.at < CLAUDE_FRESH_MS);
  if (!fresh) return null;
  const rl = fresh.rateLimits;
  const window = (w, label) => (w ? { label, usedPercent: w.used_percentage ?? null, resetsAt: w.resets_at ? w.resets_at * 1000 : null } : null);
  return { windows: [window(rl.five_hour, '5h'), window(rl.seven_day, '7d'), window(rl.spend_limit, 'spend')].filter(Boolean), at: fresh.at, from: fresh.sessionId };
}

// One session's own context, cost and cache warmth, if its statusline has
// rendered recently.
export function claudeSessionStatus(sessionId) {
  if (!sessionId) return null;
  const rec = getRecord(magiHome(), 'usage-claude', sessionId) ?? legacyState().statuses.get(sessionId);
  if (!rec) return null;
  if (Date.now() - rec.at > CLAUDE_FRESH_MS) return null;
  return {
    at: rec.at,
    model: rec.model,
    contextPercent: rec.contextWindow?.used_percentage ?? null,
    contextTokens: rec.contextWindow?.total_input_tokens ?? rec.contextWindow?.used_tokens ?? null,
    contextSize: rec.contextWindow?.context_window_size ?? null,
    costUsd: rec.cost?.total_cost_usd ?? null,
    cacheWarm: typeof rec.promptCache?.warm === 'boolean' ? rec.promptCache.warm : null,
  };
}

export async function usageSummary() {
  return { claude: claudeUsage(), codex: await codexUsage() };
}

// --- the statusline hook --------------------------------------------------


export function readChain() {
  const stored = getRecord(magiHome(), 'settings', 'statusline-chain');
  return stored?.cleared ? null : stored ?? legacyState().chain;
}

export function writeChain(rec) {
  // A tombstone prevents uninstall from resurrecting the one-time legacy fallback.
  transaction(magiHome(), () => setRecord(magiHome(), 'settings', 'statusline-chain', rec ?? { cleared: true }));
}

// `magi statusline`: record the JSON, then let the user's own statusline
// (if any) render as before, with the same input.
export async function runStatusline(input, { chain = readChain() } = {}) {
  let json = null;
  try {
    json = JSON.parse(input);
  } catch {
    /* Claude always sends JSON; a bad payload is recorded as nothing */
  }
  if (json) {
    try {
      recordClaudeStatus(json);
    } catch {
      /* the status line must never fail because of us */
    }
  }
  if (chain?.command) {
    return new Promise((resolve) => {
      const child = spawn(chain.command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('close', () => resolve(out));
      child.on('error', () => resolve(''));
      child.stdin.end(input);
    });
  }
  // No chained statusline: a minimal line of our own.
  if (!json) return '';
  const rl = json.rate_limits ?? {};
  const parts = [json.model?.display_name ?? json.model?.id ?? null, json.context_window?.used_percentage != null ? `ctx ${Math.round(json.context_window.used_percentage)}%` : null, rl.five_hour ? `5h ${Math.round(rl.five_hour.used_percentage)}%` : null, rl.seven_day ? `7d ${Math.round(rl.seven_day.used_percentage)}%` : null, json.prompt_cache?.warm === true ? 'warm' : json.prompt_cache?.warm === false ? 'cold' : null].filter(Boolean);
  return parts.join(' · ');
}
