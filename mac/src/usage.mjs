// Subscription meters: how much of each plan's window is used, and when it resets. One shape for
// every provider so the phone can draw one strip:
//   { id, label, plan, state: ok|warning|full|unmetered|signed-out|unknown, windows: [{ name, usedPct, resetsAt }], note }
//
// Sources (all read-only, none spend quota):
//   Claude  Agent SDK plan usage (experimental API) + rate_limit_event from live sessions
//   Codex   app-server account/rateLimits/read + account/rateLimits/updated
//   Google  `agy -p /usage --output-format json`: a local command, no model turn, no tokens
//   Grok    per-session usage only; we report sign-in state and label it unmetered

import { execFile } from 'node:child_process';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const TTL_MS = 60_000;

function run(cmd, args, timeout = 30_000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: `${stdout}\n${stderr}` })));
}

export function stateOf(windows) {
  const max = Math.max(0, ...windows.map((w) => w.usedPct ?? 0));
  return max >= 100 ? 'full' : max >= 80 ? 'warning' : 'ok';
}

const WINDOW_NAMES = { five_hour: '5 hours', seven_day: 'Week', seven_day_opus: 'Week · Opus', seven_day_sonnet: 'Week · Sonnet' };

export function claudeWindows(limits = {}) {
  return Object.entries(WINDOW_NAMES)
    .filter(([k]) => limits[k] && limits[k].utilization != null)
    .map(([k, name]) => ({ name, usedPct: Math.round(limits[k].utilization), resetsAt: limits[k].resets_at ? Date.parse(limits[k].resets_at) : null }));
}

export function codexWindows(snap) {
  const out = [];
  const add = (w) => {
    if (!w) return;
    const mins = w.windowDurationMins;
    const name = !mins ? 'Limit' : mins >= 10000 ? 'Week' : mins >= 1440 ? `${Math.round(mins / 1440)} days` : `${Math.round(mins / 60)} hours`;
    out.push({ name, usedPct: w.usedPercent ?? w.usedPct, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
  };
  add(snap?.primary); add(snap?.secondary);
  return out;
}

// Antigravity's /usage groups (one shared weekly limit per model group) → windows.
export function agyWindows(data) {
  const out = [];
  for (const g of data?.groups || []) {
    for (const b of g.buckets || []) {
      if (b.remaining_fraction == null) continue;
      const group = String(g.name || '').replace(/ models?$/i, '');
      const span = b.window === 'weekly' ? 'Week' : b.window === 'five_hour' || /5h|five/i.test(b.window || '') ? '5 hours' : (b.window || 'Limit');
      out.push({ name: group ? `${span} · ${group}` : span, usedPct: Math.round((1 - b.remaining_fraction) * 100), resetsAt: b.reset_time ? Date.parse(b.reset_time) : null });
    }
  }
  return out;
}

export function makeUsage({ hub, codexCall, query = sdk.query, claudePath, log = () => {} }) {
  const cache = new Map(); // id → { at, value }
  const live = { claude: new Map() }; // rateLimitType → window, from session events

  // Live sessions report Claude windows as they go; fold them in between polls.
  hub?.on('rate-limit', (info) => {
    if (!info?.rateLimitType || info.utilization == null) return;
    live.claude.set(info.rateLimitType, { name: WINDOW_NAMES[info.rateLimitType] || info.rateLimitType, usedPct: Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)), resetsAt: info.resetsAt ? info.resetsAt * 1000 : null });
    cache.delete('claude');
  });

  async function claude() {
    let q;
    try {
      let release;
      const idle = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((r) => { release = r; }) }) };
      q = query({ prompt: idle, options: { ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}), persistSession: false } });
      const u = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 20_000)),
      ]);
      const windows = claudeWindows(u.rate_limits || {});
      return { id: 'claude', label: 'Claude', plan: u.subscription_type, state: u.rate_limits_available ? stateOf(windows) : 'unknown', windows };
    } catch (e) {
      const windows = [...live.claude.values()];
      return { id: 'claude', label: 'Claude', state: windows.length ? stateOf(windows) : 'unknown', windows, note: `meter unavailable: ${e.message}` };
    } finally {
      try { q?.close?.(); } catch {}
    }
  }

  async function codex() {
    try {
      const r = await codexCall('account/rateLimits/read', {});
      const snap = r.rateLimits || Object.values(r.rateLimitsByLimitId || {})[0];
      const windows = codexWindows(snap);
      const full = r.ordinaryUsageAllowed === false || snap?.rateLimitReachedType;
      return { id: 'codex', label: 'ChatGPT', plan: snap?.planType, state: full ? 'full' : stateOf(windows), windows, credits: snap?.credits?.balance ?? null };
    } catch (e) {
      return { id: 'codex', label: 'ChatGPT', state: 'unknown', windows: [], note: e.message };
    }
  }

  async function agy() {
    const r = await run('agy', ['-p', '/usage', '--output-format', 'json'], 30_000);
    let data = null;
    try { data = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)).command?.data; } catch {}
    const windows = agyWindows(data);
    if (windows.length) return { id: 'agy', label: 'Google', plan: 'Antigravity', state: stateOf(windows), windows };
    const signedIn = r.ok && !/sign ?in|log ?in|auth/i.test(r.out);
    return { id: 'agy', label: 'Google', plan: 'Antigravity', state: signedIn ? 'unknown' : 'signed-out', windows: [], note: signedIn ? 'Antigravity did not report usage' : 'Run agy on the Mac to sign in' };
  }

  async function grok() {
    const r = await run('grok', ['models'], 20_000);
    const signedIn = r.ok && !/not authenticated/i.test(r.out);
    return { id: 'grok', label: 'Grok', state: signedIn ? 'unmetered' : 'signed-out', windows: [], note: signedIn ? 'Grok reports usage per session only' : 'Run grok login on the Mac' };
  }

  const sources = { claude, codex, agy, grok };

  async function one(id, fresh) {
    const c = cache.get(id);
    if (!fresh && c && Date.now() - c.at < TTL_MS) return c.value;
    const value = { ...(await sources[id]()), checkedAt: Date.now() };
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  return {
    async all({ fresh = false } = {}) {
      const rows = await Promise.all(Object.keys(sources).map((id) => one(id, fresh).catch((e) => ({ id, label: id, state: 'unknown', windows: [], note: e.message }))));
      return { providers: rows };
    },
  };
}
