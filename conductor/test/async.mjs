// Proof of the hero feature: Mara is NOT blocked while a build runs. We fire a real build
// in the background, then — while it's still going — ask Mara a second question and confirm
// she answers immediately (the old code would have said "hold that thought" for minutes).
// Replicates run-live's plumbing (turn queue + in-flight registry + fire-and-forget) headless.
//
//   node test/async.mjs
//
// Spawns ONE real Claude worker (subscription) + a few cheap Mara/engineer turns.

import { Conductor } from '../src/conductor.mjs';
import { Mara } from '../src/mara.mjs';
import { loadTeam } from '../src/team.mjs';
import { makeRoom } from '../src/room.mjs';
import { ScratchRepo } from '../src/workspace.mjs';
import { mkdirSync, rmSync } from 'node:fs';

const WORK = '/tmp/walkie-async-test';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unique workspace name so this never collides with the live service's "walkie" workspace.
const c = new Conductor({ workspace: `walkie-async-${Date.now()}`, emName: 'Mara', cwd: WORK, log });
await c.start();
const mara = new Mara({ log });
const team = loadTeam({ log });
const speakers = new Map();
for (const eng of team.values()) speakers.set(eng.name.toLowerCase(), await c.registerSpeaker(eng.name));
const repo = new ScratchRepo({ root: WORK, log });
const runRoom = makeRoom({ conductor: c, team, speakers, repo, log });

// --- run-live's plumbing, headless ---
let turnChain = Promise.resolve();
const enqueueTurn = (job) => (turnChain = turnChain.then(job).catch((e) => log(`turn error: ${e.message}`)));
let taskSeq = 0;
const inFlight = new Map();
let surfaced = false;
let narratedMidBuild = false; // did Mara voice the plan WHILE the build was still running?
function listWork() {
  if (!inFlight.size) return 'Nothing is building right now — the board is clear.';
  return [...inFlight.values()].map((r) => `- ${r.worker}: "${r.directive.slice(0, 60)}" — building`).join('\n');
}
// Real milestone → Mara narrates the plan (tool-free narration turn), like run-live.
function onProgress({ phase, worker, directive, ack }) {
  if (phase !== 'acked') return;
  const before = said.length;
  enqueueTurn(async () => {
    await mara.respond(`[Progress update — not from the Director] ${worker} just picked up "${directive}", plan: "${ack}". One short line in your voice on what's happening now. Don't dispatch.`, io, { tools: false });
    if (said.length > before && inFlight.size > 0) narratedMidBuild = true;
  });
}
function startTask({ worker, directive }) {
  const id = ++taskSeq;
  inFlight.set(id, { worker, directive });
  runRoom({ worker, directive, taskId: id, onProgress })
    .then((o) => { inFlight.delete(id); enqueueTurn(() => { surfaced = true; return mara.respond(`[Background update — not from the Director] ${worker}'s task finished, verified=${o.verified}. Tell the Director briefly.`, io); }); })
    .catch((e) => { inFlight.delete(id); log(`task error: ${e.message}`); });
  return `Started ${worker} in the background. Keep talking; I'll surface it when it lands.`;
}
const said = [];
const io = { say: (t) => { said.push(t); return c.say(t); }, startTask, listWork };

// 1) Fire a build. This turn should return fast (fire-and-forget), NOT wait for the build.
log('\n=== Director: "Have Theo create a file called slow.txt containing the single word: done" ===');
const t0 = Date.now();
await enqueueTurn(() => mara.respond('Have Theo create a file called slow.txt containing the single word: done', io));
const dispatchTurnMs = Date.now() - t0;
const fired = inFlight.size >= 1;
log(`dispatch turn returned in ${dispatchTurnMs}ms; in flight: ${inFlight.size}`);

// 2) While the build is STILL running, ask a second question. The old busy-guard would block
//    this for the whole build; now it should come back in seconds, mid-build.
let answeredDuringBuild = false;
if (inFlight.size >= 1) {
  log('\n=== Director (mid-build): "Quick — what is the team working on right now?" ===');
  const before = said.length;
  const t1 = Date.now();
  await enqueueTurn(() => mara.respond('Quick — what is the team working on right now?', io));
  const secondTurnMs = Date.now() - t1;
  answeredDuringBuild = inFlight.size >= 1 && said.length > before; // still building AND she spoke
  log(`second turn returned in ${secondTurnMs}ms; build still in flight: ${inFlight.size >= 1}; she spoke: ${said.length > before}`);
}

// 3) Let the build finish and surface.
const deadline = Date.now() + 600000;
while (inFlight.size > 0 && Date.now() < deadline) await sleep(1000);
await turnChain; // drain the surface turn
await sleep(500);

console.log('\n──────── everything Mara said ────────');
for (const s of said) console.log(`  Mara: ${s}`);

console.log('\n=================== RESULTS ===================');
console.log('  dispatch turn was non-blocking:    ', fired && dispatchTurnMs < 30000 ? `✅ (${dispatchTurnMs}ms, build kept running)` : '❌');
console.log('  Mara narrated the plan mid-build:   ', narratedMidBuild ? '✅ (kept the Director in the loop)' : '❌');
console.log('  Mara answered DURING the build:     ', answeredDuringBuild ? '✅ (no "hold that thought")' : '❌');
console.log('  build finished + surfaced:          ', surfaced ? '✅' : '❌');
console.log('==============================================');

const pass = fired && dispatchTurnMs < 30000 && narratedMidBuild && answeredDuringBuild && surfaced;
console.log(pass ? '✅ ASYNC DISPATCH WORKS — Mara talks while the team builds' : '❌ async dispatch incomplete');
process.exit(pass ? 0 : 1);
