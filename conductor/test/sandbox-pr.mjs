// The real thing: Mara puts an engineer on a task, a builder makes the change in a fresh
// WORKTREE of the walkie-sandbox checkout, and it lands as a genuine GitHub PR the Director
// can review. Drives the same async flow as run-live (fire-and-forget → await → surface).
//
//   node test/sandbox-pr.mjs
//
// Needs a sandbox checkout (~/walkie-sandbox) + gh auth. Opens a REAL PR on walkie-sandbox.

import { Conductor } from '../src/conductor.mjs';
import { Mara } from '../src/mara.mjs';
import { loadTeam } from '../src/team.mjs';
import { makeRoom } from '../src/room.mjs';
import { SandboxRepo } from '../src/workspace.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SANDBOX_DIR = process.env.WALKIE_SANDBOX_DIR ?? join(homedir(), 'walkie-sandbox');
const SANDBOX_REPO = process.env.WALKIE_SANDBOX_REPO ?? 'you/your-sandbox';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!existsSync(join(SANDBOX_DIR, '.git'))) { console.error(`no sandbox checkout at ${SANDBOX_DIR}`); process.exit(2); }

// Unique workspace name so this never collides with the live service's "walkie" workspace.
const c = new Conductor({ workspace: `walkie-sbpr-${Date.now()}`, emName: 'Mara', cwd: SANDBOX_DIR, log });
await c.start();
const mara = new Mara({ log });
const team = loadTeam({ log });
const speakers = new Map();
for (const eng of team.values()) speakers.set(eng.name.toLowerCase(), await c.registerSpeaker(eng.name));
const repo = new SandboxRepo({ root: SANDBOX_DIR, repo: SANDBOX_REPO, log });
repo.pruneStale();
const runRoom = makeRoom({ conductor: c, team, speakers, repo, log });

const pending = [];
const startTask = ({ worker, directive }) => {
  pending.push(runRoom({ worker, directive, taskId: pending.length + 1 }));
  return `Started ${worker} on it in the background.`;
};
const io = { say: (t) => c.say(t), startTask, listWork: () => `${pending.length} task(s) in flight` };

const directive = 'Create a file apps/hello/README.md with a short, friendly hello from the Walkie team and one sentence on what this sandbox is for.';
log(`\n=== Director: "${directive}" ===\n`);
await mara.respond(directive, io);

const [outcome] = await Promise.all(pending);
if (outcome) {
  const note = outcome.verified
    ? `[Background update — not from the Director] The task finished and VERIFIED.${outcome.prUrl ? ` PR: ${outcome.prUrl}` : ''} Tell the Director briefly.`
    : `[Background update — not from the Director] The task came back BLOCKED. Tell the Director.`;
  await mara.respond(note, io);
}
await new Promise((r) => setTimeout(r, 1500));

console.log('\n──────── #work (the team room) ────────');
for (const m of c.transcript.filter((m) => m.channel === 'work')) console.log(`  ${m.from}: ${m.text}`);
console.log('\n──────── #standup (Mara → the Director) ────────');
for (const m of c.transcript.filter((m) => m.channel === 'standup')) console.log(`  ${m.from}: ${m.text}`);

console.log('\n=================== RESULTS ===================');
console.log('  PR opened: ', outcome?.prUrl ? `✅ ${outcome.prUrl}` : '❌ none');
console.log('==============================================');
process.exit(outcome?.prUrl ? 0 : 1);
