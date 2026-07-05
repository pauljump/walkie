import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The cost readout. The builders run on the Claude subscription (flat, not metered), so the
// only real dollar meter is the conversational layer — Mara + the engineer voices on the
// Anthropic API. This accumulates their token usage into a running $ total (sonnet-4-6
// rates) and persists it to ~/.walkie/usage.json so it survives restarts.

const DIR = join(homedir(), '.walkie');
const FILE = join(DIR, 'usage.json');
// claude-sonnet-4-6, $ per token: input $3/M, output $15/M, cache read 0.1x, cache write 1.25x.
const RATE = { input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function load() {
  if (existsSync(FILE)) { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch {} }
  return { since: new Date().toISOString().slice(0, 10), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}
function save(s) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2)); }

// Record one Anthropic API response's usage. Returns { turnUsd, totalUsd }.
export function record(usage) {
  const s = load();
  if (!usage) return { turnUsd: 0, totalUsd: s.costUsd };
  const i = usage.input_tokens || 0, o = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0, cw = usage.cache_creation_input_tokens || 0;
  const turnUsd = i * RATE.input + o * RATE.output + cr * RATE.cacheRead + cw * RATE.cacheWrite;
  s.calls++; s.input += i; s.output += o; s.cacheRead += cr; s.cacheWrite += cw; s.costUsd += turnUsd;
  save(s);
  return { turnUsd, totalUsd: s.costUsd };
}

// A one-line, spoken-friendly summary Mara can relay if the Director asks what it's costing.
export function summary() {
  const s = load();
  return `Metered spend on me and the team's voices is $${s.costUsd.toFixed(4)} over ${s.calls} calls since ${s.since}. The engineers' actual building runs on your Claude subscription, so that part is flat.`;
}
