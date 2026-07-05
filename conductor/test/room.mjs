// Headless proof of the team room: a real task driven by Mara, through a real engineer,
// with a real harness worker doing the build. Drives the SAME async flow as run-live —
// Mara fires the build in the background, we await it, then surface the verdict — and
// checks the engineer's persistent track record got an entry.
//
//   node test/room.mjs
//
// Uses throwaway workspaces (no broker needed). Spawns ONE real Claude worker.

import { Conductor } from '../src/conductor.mjs';
import { Mara } from '../src/mara.mjs';
import { loadTeam } from '../src/team.mjs';
import { makeRoom } from '../src/room.mjs';
import { ScratchRepo } from '../src/workspace.mjs';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORK = '/tmp/walkie-room-test';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Unique workspace name so this never collides with the live service's "walkie" workspace.
const c = new Conductor({ workspace: `walkie-room-${Date.now()}`, emName: 'Mara', cwd: WORK, log });
await c.start();
const mara = new Mara({ log });
const team = loadTeam({ log });
const speakers = new Map();
for (const eng of team.values()) speakers.set(eng.name.toLowerCase(), await c.registerSpeaker(eng.name));
// Scratch workspaces = file-snapshot change detection, no git/PR (headless, no GitHub).
const repo = new ScratchRepo({ root: WORK, log });
const runRoom = makeRoom({ conductor: c, team, speakers, repo, log });

// Mirror run-live: dispatch is fire-and-forget. startTask kicks the build off in the
// background and returns an immediate ack; we collect the promise to await below.
const pending = [];
const startTask = ({ worker, directive }) => {
  pending.push(runRoom({ worker, directive, taskId: pending.length + 1 }));
  return `Started ${worker} on it in the background.`;
};
const io = { say: (t) => c.say(t), startTask, listWork: () => `${pending.length} task(s) in flight` };

// Capture Theo's track-record length before, to prove persistence after.
const theoMem = join(homedir(), '.walkie', 'team', 'theo.md');
const before = existsSync(theoMem) ? readFileSync(theoMem, 'utf8').split('\n').filter((l) => l.startsWith('- ')).length : 0;

const directive = 'Create a file called room-proof.txt whose only contents are the single word: alive';
log(`\n=== Director: "${directive}" ===\n`);
await mara.respond(directive, io);

// The build runs in the background — wait for it, then surface the verdict like run-live does.
const outcomes = await Promise.all(pending);
for (const o of outcomes) {
  const note = o.verified
    ? `[Background update — not from the Director] Theo's task finished and VERIFIED. Tell the Director briefly.`
    : `[Background update — not from the Director] Theo's task came back BLOCKED. Tell the Director.`;
  await mara.respond(note, io);
}

// Give the listener a beat to flush the last posts into the feed.
await new Promise((r) => setTimeout(r, 1500));

const onChan = (ch) => c.transcript.filter((m) => m.channel === ch);
console.log('\n──────── #work (the team room — the Director watches this) ────────');
for (const m of onChan('work')) console.log(`  ${m.from}: ${m.text}`);
console.log('\n──────── #standup (Mara → the Director) ────────');
for (const m of onChan('standup')) console.log(`  ${m.from}: ${m.text}`);

const fileOk = outcomes.some((o) => o.verified); // the worker wrote into its own worktree subdir
const after = existsSync(theoMem) ? readFileSync(theoMem, 'utf8').split('\n').filter((l) => l.startsWith('- ')).length : 0;
const memOk = after > before;
const workVoices = new Set(onChan('work').map((m) => m.from.toLowerCase()));
const roomAlive = workVoices.has('mara') && [...workVoices].some((v) => ['theo', 'cora', 'nia'].includes(v));

console.log('\n=================== RESULTS ===================');
console.log('  build verified (file actually built):', fileOk ? '✅' : '❌');
console.log('  team room had Mara + engineer:       ', roomAlive ? '✅' : '❌');
console.log("  engineer's track record grew:        ", memOk ? `✅ (${before} → ${after})` : '❌');
console.log('==============================================');

const pass = fileOk && roomAlive && memOk;
console.log(pass ? '✅ THE ROOM IS ALIVE — Mara ran the team async, the Director can watch' : '❌ room incomplete');
process.exit(pass ? 0 : 1);
