import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = 'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS';
const DEFAULT_MS = 300000;
const PRESETS = { '60s': 60000, '5m': DEFAULT_MS, '10m': 600000, never: 0 };

export function readClaudeDialogSettings() {
  try {
    const value = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    return error.code === 'ENOENT' ? {} : null;
  }
}

// Claude 2.1.302: these are observations here, not another session's policy.
// Invalid overrides stay unknown; guessing a deadline would imply a false expiry.
export function claudeDialogTimeout(settings = readClaudeDialogSettings()) {
  let raw = process.env[KEY];
  let source = 'Magi process environment';
  if (raw === undefined && settings?.env && Object.hasOwn(settings.env, KEY)) {
    raw = settings.env[KEY];
    source = 'user settings.json env';
  }
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^\+?\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
      return { ms: null, source, error: 'override' };
    }
    return { ms: Number(raw), source };
  }
  if (settings === null) return { ms: null, source: 'user settings.json', error: 'unreadable' };
  const preset = settings.dialogExpiry;
  return typeof preset === 'string' && Object.hasOwn(PRESETS, preset)
    ? { ms: PRESETS[preset], source: 'user settings.json dialogExpiry' }
    : { ms: DEFAULT_MS, source: 'Claude default (no observed env/user override)' };
}

export function claudeDialogTimeoutInfo(settings) {
  const { ms, source, error } = claudeDialogTimeout(settings);
  if (error === 'override') return `${KEY}: effective timeout unknown (unrecognized millisecond override in ${source}; value withheld). Held PEER messages can expire and be dropped, appearing stalled; inspect this one setting.`;
  if (error === 'unreadable') return `${KEY}: effective timeout unknown (user settings.json unreadable); Claude's built-in default is 300000 ms (5 min). A held PEER message can expire and be dropped, appearing stalled.`;
  const held = ms === 0 ? 'a held PEER message has no expiry deadline'
    : `a held PEER message to a Claude session is dropped after ${ms / 60000} min unless approved`;
  return `${KEY}: ${ms} ms; source: ${source}; ${held}. Expiry can look like a stalled peer. Forwarded dialogs share it; local-only prompts are unaffected. Observed here, not a guarantee for another session's policy/env.`;
}

// A possible explanation, never evidence of failure or model consumption.
export function claudeReceiptHint(receipt, now, timeout) {
  if (receipt.to !== 'claude' || !['unconfirmed', 'queued_unread'].includes(receipt.deliveryStatus ?? 'unconfirmed')) return '';
  const via = String(receipt.via ?? '');
  if (!/^(?:relay:[^:]+:)?live(?::|$)/.test(via) || receipt.target?.headless) return '';
  if (!Number.isFinite(receipt.at) || !(timeout.ms > 0) || now - receipt.at <= timeout.ms) return '';
  return `may have been held for approval at that Claude session and dropped after ${timeout.ms / 60000} min; ask the user to check/approve there or resend`;
}
