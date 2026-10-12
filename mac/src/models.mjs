// One model list across every subscription, for the phone's picker. Each row says which harness
// (CLI) runs it and which subscription pays, because the same model can be reachable twice (e.g.
// Claude Opus through Claude Code, or through Antigravity on the Google plan).

import { execFile } from 'node:child_process';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const TTL_MS = 10 * 60_000;
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 30_000 }, (e, out) => r(e ? '' : String(out))));

export const HARNESS = {
  claude: { name: 'Claude Code', plan: 'claude', approvals: 'per-call' },
  codex: { name: 'Codex', plan: 'codex', approvals: 'per-call' },
  agy: { name: 'Antigravity', plan: 'agy', approvals: 'mode-only' },
  grok: { name: 'Grok', plan: 'grok', approvals: 'per-call' },
};

export function parseAgyModels(out) {
  return out.split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2 && p[0].trim())
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
}
export function parseGrokModels(out) {
  return [...out.matchAll(/^\s*[-*]\s+(\S+)(\s+\(default\))?/gm)].map((m) => ({ id: m[1], name: m[1].replace(/^grok-/, 'Grok ').replace(/-/g, ' '), isDefault: Boolean(m[2]) }));
}

// Rough family for grouping and for noticing the same model across harnesses.
export function family(id) {
  const s = id.toLowerCase();
  if (/fable|mythos/.test(s)) return 'Claude Fable';
  if (/opus/.test(s)) return 'Claude Opus';
  if (/sonnet/.test(s)) return 'Claude Sonnet';
  if (/haiku/.test(s)) return 'Claude Haiku';
  if (/gemini.*pro/.test(s)) return 'Gemini Pro';
  if (/gemini.*flash/.test(s)) return 'Gemini Flash';
  if (/gpt-oss/.test(s)) return 'GPT-OSS';
  if (/^gpt|astra|sol|terra|luna/.test(s)) return 'GPT';
  if (/grok/.test(s)) return 'Grok';
  return 'Other';
}

// Claude Code still accepts these by full id even when it only advertises the current aliases.
export const CLAUDE_OLDER = [
  ['claude-fable-5', 'Fable 5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-4-6', 'Sonnet 4.6'],
];
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Antigravity encodes effort in the id (gemini-3.8-flash-high/medium/low): fold those into one model.
export function foldAgyEfforts(list) {
  const out = new Map();
  for (const m of list) {
    const e = m.id.match(/^(.*)-(low|medium|high)$/);
    const base = e ? e[1] : m.id;
    const row = out.get(base) || { id: base, name: m.name.replace(/\s*\((Low|Medium|High)\)$/, ''), efforts: [], effortIds: {} };
    if (e) { row.efforts.push(e[2]); row.effortIds[e[2]] = m.id; } else row.single = m.id;
    out.set(base, row);
  }
  return [...out.values()].map((r) => (r.efforts.length ? { id: r.id, name: r.name, efforts: ['low', 'medium', 'high'].filter((x) => r.efforts.includes(x)), defaultEffort: r.efforts.includes('medium') ? 'medium' : r.efforts[0], effortIds: r.effortIds } : { id: r.single, name: r.name }));
}

export function makeModels({ codexCall, query = sdk.query, claudePath }) {
  let cache = null; let at = 0;

  async function claude() {
    let q;
    try {
      const idle = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
      q = query({ prompt: idle, options: { ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}), persistSession: false } });
      const list = await Promise.race([q.supportedModels(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20_000))]);
      const current = list.filter((m) => m.value !== 'default').map((m) => ({
        id: m.value, name: m.displayName || m.value, description: m.description, resolves: m.resolvedModel,
        efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels || ALL_EFFORTS), defaultEffort: 'high',
      }));
      const have = new Set(current.flatMap((m) => [m.id, m.resolves].filter(Boolean)));
      const older = CLAUDE_OLDER.filter(([id]) => !have.has(id)).map(([id, name]) => ({ id, name, older: true, efforts: ALL_EFFORTS, defaultEffort: 'high' }));
      return [...current, ...older];
    } catch { return []; } finally { try { q?.close?.(); } catch {} }
  }
  async function codex() {
    try {
      return ((await codexCall('model/list', {})).data || []).filter((m) => !m.hidden).map((m) => ({
        id: m.id ?? m.model, name: m.displayName ?? m.id, description: m.description,
        older: /\b(older|legacy)\b/i.test(m.description || ''),
        efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort,
      }));
    } catch { return []; }
  }

  return {
    async all({ fresh = false } = {}) {
      if (!fresh && cache && Date.now() - at < TTL_MS) return cache;
      const [c, x, a, g] = await Promise.all([claude(), codex(), run('agy', ['models']).then((o) => foldAgyEfforts(parseAgyModels(o))), run('grok', ['models']).then(parseGrokModels)]);
      const rows = [];
      const add = (harness, list) => list.forEach((m) => rows.push({ ...m, key: `${harness}/${m.id}`, harness, harnessName: HARNESS[harness].name, approvals: HARNESS[harness].approvals, family: family(m.id) }));
      add('claude', c); add('codex', x); add('agy', a); add('grok', g);
      cache = { models: rows }; at = Date.now();
      return cache;
    },
  };
}
