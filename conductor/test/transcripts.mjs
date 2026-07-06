// User-owned walk transcripts — $0, no network, no LLM.
// Proves: messages land in the daily JSONL; #build is skipped; the off switch produces nothing;
// a write failure can't throw. Uses recordMessage directly with explicit cfg (no live config).

import { recordMessage, transcriptsDir } from '../src/transcripts.mjs';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checks = [];
const check = (label, ok) => checks.push({ label, ok });

const stateDir = join(tmpdir(), `walkie-transcripts-test-${process.pid}`);
rmSync(stateDir, { recursive: true, force: true });
const cfg = { stateDir, transcripts: true };

// ── 1. Messages land, in order, with the fields we promised ─────────────────────────────────
recordMessage({ channel: 'standup', from: 'Director', text: 'Been thinking about Curfew again.', seq: 1 }, { cfg });
recordMessage({ channel: 'work', from: 'Cora', text: 'Page is up. PR opened.', seq: 2 }, { cfg });
recordMessage({ channel: 'build', from: 'TheoHands0001', text: 'raw stdout noise', seq: 3 }, { cfg });

const dir = transcriptsDir(cfg);
// LOCAL day, matching the module ("what did I say on Tuesday's walk" is a local-time question;
// an ISO/UTC lookup here fails every evening west of Greenwich).
const d = new Date();
const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const files = existsSync(dir) ? readFileSync(join(dir, `${day}.jsonl`), 'utf8') : '';
const lines = files.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

check('two messages recorded (standup + work)', lines.length === 2);
check('standup line has from/text/seq/ts', lines[0]?.from === 'Director' && lines[0]?.seq === 1 && !!lines[0]?.ts && lines[0]?.channel === 'standup');
check('work line recorded', lines[1]?.from === 'Cora' && lines[1]?.channel === 'work');
check('#build skipped (noise is not conversation)', !files.includes('raw stdout noise'));

// ── 2. Off switch: nothing written ───────────────────────────────────────────────────────────
const offDir = join(tmpdir(), `walkie-transcripts-off-${process.pid}`);
rmSync(offDir, { recursive: true, force: true });
recordMessage({ channel: 'standup', from: 'Director', text: 'should not persist' }, { cfg: { stateDir: offDir, transcripts: false } });
check('transcripts:false writes nothing', !existsSync(join(offDir, 'transcripts')));

// ── 3. A hostile stateDir cannot throw ───────────────────────────────────────────────────────
let threw = false;
try { recordMessage({ channel: 'standup', from: 'x', text: 'y' }, { cfg: { stateDir: '/dev/null/nope', transcripts: true } }); } catch { threw = true; }
check('write failure swallowed (never breaks the walk)', !threw);

// ── report ───────────────────────────────────────────────────────────────────────────────────
rmSync(stateDir, { recursive: true, force: true });
rmSync(offDir, { recursive: true, force: true });
console.log('\n=================== RESULTS ===================');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.label}`);
console.log('==============================================');
const pass = checks.every((c) => c.ok);
console.log(pass ? '✅ TRANSCRIPTS ARE THE USER\'S OWN (local, skippable, unbreakable)' : '❌ transcript layer broken');
process.exit(pass ? 0 : 1);
