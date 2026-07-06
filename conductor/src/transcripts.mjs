// Walk transcripts — the user's OWN record of their own words, on their own Mac.
//
// The live room is in-memory and forgets on restart (a walk is a call). But the brain dump is
// the whole point of a walk, so we keep the user's copy: every message on the voice line and in
// the team room is appended to a daily JSONL file under ~/.walkie/transcripts/. Nothing here
// ever leaves the machine — this is storage FOR the operator, not collection FROM them.
//
// Rules:
//   1. Local only. This module writes to disk; it never touches the network.
//   2. On by default (cfg.transcripts !== false): they're the operator's words on the
//      operator's disk. Off switch: "transcripts": false in ~/.walkie/config.json.
//   3. #build is skipped — raw builder stdout is noise, not conversation. #standup (the walk)
//      and #work (the team room) are recorded.
//   4. Never throws, never blocks: a full disk or weird permissions must not break the call.
//
// Format: one JSON object per line — { ts, seq, channel, from, text } — greppable with jq or
// plain grep, and parseable later by walk-to-walk memory features.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';

const SKIP_CHANNELS = new Set(['build']);

export function transcriptsDir(cfg = loadConfig()) {
  return join(cfg.stateDir || join(homedir(), '.walkie'), 'transcripts');
}

// The current day's file, local time — "what did I say on Tuesday's walk" maps to a filename.
function todayFile(dir) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(dir, `${day}.jsonl`);
}

// Append one message. Fire-and-forget from the caller's perspective: any failure is swallowed
// (rule 4). Pass cfg for tests; defaults to the live config.
export function recordMessage({ channel, from, text, seq }, { cfg } = {}) {
  try {
    const c = cfg ?? loadConfig();
    if (c.transcripts === false) return;
    const ch = channel || 'standup';
    if (SKIP_CHANNELS.has(ch)) return;
    if (!text) return;
    const dir = transcriptsDir(c);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: seq ?? undefined,
      channel: ch,
      from: String(from ?? ''),
      text: String(text),
    });
    appendFileSync(todayFile(dir), line + '\n');
  } catch {
    /* a transcript write must never break the walk */
  }
}
