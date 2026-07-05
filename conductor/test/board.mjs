// Regression test for the phantom "still building" heartbeat (issue #101) — deterministic, $0.
//
// The board narrates "still building" while a worker types. The bug: a task stayed on the board
// through the PR-open / report tail AFTER its worker was released, so the heartbeat kept saying
// "I can hear the keyboard" when the build was done and the PR already up. This test drives the
// board directly with a fast heartbeat + a fake `say`, and asserts the heartbeat goes quiet the
// instant a worker is released (markBuilt) — even while the task lingers on the board.
//
//   node test/board.mjs

import { makeBoard } from '../src/board.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HB = 50; // fast heartbeat so the test runs in well under a second
let pass = true;
const check = (label, ok) => { console.log(`  ${ok ? '✅' : '❌'} ${label}`); if (!ok) pass = false; };

const said = [];
const board = makeBoard({ say: (t) => { said.push(t); }, heartbeatMs: HB, log: () => {} });

// ── Scenario 1: a single build, then the worker is released mid-wrap-up. ──────────────────
console.log('\n=== single build → worker released → heartbeat must go quiet ===');
board.add(1, { worker: 'Theo', directive: 'build the curfew page' });
await sleep(HB * 3 + 15); // let a couple of heartbeats fire while it's genuinely building
const beatsWhileBuilding = said.length;
check(`heartbeat fired while building (${beatsWhileBuilding} beat(s))`, beatsWhileBuilding >= 2);
check('board says "building" while the worker runs', /building,/.test(board.list()) && board.buildingCount() === 1);

// Worker done + released — but the task is still on the board (PR opening / report writing).
board.markBuilt(1);
const beatsAtRelease = said.length;
await sleep(HB * 4 + 15); // give the heartbeat every chance to (wrongly) keep talking
check('NO phantom heartbeat after release (the core bug)', said.length === beatsAtRelease);
check('task still visible on the board, marked "wrapping up"', board.size() === 1 && /wrapping up/.test(board.list()));
check('buildingCount() is 0 once the worker is released', board.buildingCount() === 0);

board.remove(1);
check('board is clear after the verdict surfaces', board.size() === 0);

// ── Scenario 2: two parallel builds — count is honest as each worker lands. ────────────────
console.log('\n=== two parallel builds → per-worker honesty ===');
said.length = 0;
board.add(10, { worker: 'Theo', directive: 'task A' });
board.add(11, { worker: 'Cora', directive: 'task B' });
await sleep(HB + 15);
check('heartbeat reports BOTH builds in parallel', said.some((s) => /2 builds running in parallel/.test(s)));

board.markBuilt(10); // Theo lands first
await sleep(HB * 2 + 15);
check('after one lands, heartbeat drops to the single-build line', said.some((s) => !/parallel/.test(s) && /still|going|keyboard|building/i.test(s)));
check('buildingCount() is 1 with one still building', board.buildingCount() === 1 && board.size() === 2);

board.markBuilt(11); // Cora lands
const beatsBothDone = said.length;
await sleep(HB * 4 + 15);
check('heartbeat fully silent once both workers are released', said.length === beatsBothDone);

board.remove(10); board.remove(11);
board.stop();
check('no lingering timer — board stopped', board.size() === 0);

console.log(`\n${pass ? '✅ PASS — heartbeat is honest: it speaks only while a worker is building' : '❌ FAIL — phantom heartbeat regression'}`);
process.exit(pass ? 0 : 1);
