// Provider policy and observed health live in one row of the Magi database
// (namespace settings, key providers), read and written in its transaction.
import { magiHome } from './state.mjs';
import { transaction, getRecord, setRecord } from './store.mjs';
import { resolveBin, BridgeError, looksLikeAuthFailure, authError } from './exec.mjs';

const NAMES = ['claude', 'codex', 'omp'];
function readSettings() {
  try {
    const value = getRecord(magiHome(), 'settings', 'providers');
    if (value === null || value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    for (const [name, row] of Object.entries(value)) {
      if (!NAMES.includes(name) || !row || typeof row !== 'object' || Array.isArray(row)
          || (row.enabled !== undefined && typeof row.enabled !== 'boolean')
          || (row.down !== undefined && row.down !== null && typeof row.down !== 'string')
          || (row.observedAt !== undefined && (!Number.isFinite(row.observedAt) || row.observedAt < 0))
          || (row.lastClearAt !== undefined && (!Number.isFinite(row.lastClearAt) || row.lastClearAt < 0))) {
        throw new Error(`invalid provider settings for ${name}`);
      }
    }
    return value;
  } catch (e) {
    throw new BridgeError('BAD_CONFIG', `Cannot read provider settings (magi.db, settings/providers): ${e.message}. Repair or delete that row, then use "magi provider enable <name>".`);
  }
}

// Policy only, for the per-call gate: getProviders also resolves every CLI on
// PATH, a few hundred stats a request for an answer this check never reads.
export function providerEnabled(name) {
  return readSettings()[name]?.enabled !== false;
}

export function getProviders() {
  const settings = readSettings();
  return Object.fromEntries(NAMES.map((name) => {
    const row = settings[name] ?? {};
    const enabled = row.enabled !== false;
    let reason = row.down ?? null;
    if (enabled) {
      try { resolveBin(name); }
      catch (e) { reason = `${e.code ?? 'CLI_NOT_FOUND'}: ${e.message}`; }
    }
    return [name, { enabled, status: !enabled ? 'disabled' : reason ? 'down' : 'up', reason: enabled ? reason : null }];
  }));
}

// Boolean sets policy; {down} records an auth failure or clears it after a
// successful CLI call. A health update never silently re-enables a provider.
export function setProvider(name, change) {
  if (!NAMES.includes(name)) throw new BridgeError('BAD_REQUEST', `Unknown provider ${name}. Use claude, codex or omp with "magi provider list".`);
  if (typeof change !== 'boolean' && (!change || typeof change !== 'object'
      || Array.isArray(change) || !Object.hasOwn(change, 'down')
      || (change.down !== null && typeof change.down !== 'string')
      || (change.observedAt !== undefined && (!Number.isFinite(change.observedAt) || change.observedAt < 0)))) {
    throw new BridgeError('BAD_REQUEST', 'Set a provider with a boolean enabled flag or {down: reason|null}. Use "magi provider enable <name>" or "magi provider disable <name>".');
  }
  const observedAt = typeof change === 'boolean' ? null : change.observedAt ?? Date.now();
  const update = () => {
    const settings = readSettings();
    const previous = settings[name] ?? {};
    if (typeof change === 'boolean' && previous.enabled === change) return;
    if (observedAt !== null && (observedAt < (previous.observedAt ?? 0)
        || (change.down !== null && observedAt < (previous.lastClearAt ?? -1))
        || (observedAt === previous.observedAt && (previous.down ?? null) === change.down))) return;
    const next = typeof change === 'boolean' ? { ...previous, enabled: change }
      : { ...previous, down: change.down, observedAt, ...(change.down === null ? { lastClearAt: observedAt } : {}) };
    settings[name] = next;
    setRecord(magiHome(), 'settings', 'providers', settings);
  };
  // One transaction: a health write from another server never overwrites a manual disable.
  transaction(magiHome(), update);
}

// Health is telemetry, not a prerequisite for returning a reply or its error.
export function recordProviderHealth(name, change) {
  try { setProvider(name, change); }
  catch { /* Busy or unreadable health storage must not change peer work. */ }
}

export function recordProviderFailure(name, error, observedAt = Date.now()) {
  const detail = [error?.message, error?.stderr].filter(Boolean).join('\n');
  if (error?.code !== 'AUTH_REQUIRED' && !looksLikeAuthFailure(detail)) return;
  const classified = error?.code === 'AUTH_REQUIRED' ? error : authError(name, detail);
  recordProviderHealth(name, { down: `${classified.code}: ${classified.message}`, observedAt });
}
