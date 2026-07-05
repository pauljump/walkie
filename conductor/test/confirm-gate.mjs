// Proof of the confirmation gate's core guarantee: a build cannot start in the same breath it
// was proposed — the Director's go-ahead must be a separate, later turn. $0, pure logic.
//
//   node test/confirm-gate.mjs

import { ConfirmGate } from '../src/confirm-gate.mjs';

const checks = [];
const check = (label, ok) => checks.push({ label, ok });

// Propose on turn 1.
const gate = new ConfirmGate();
gate.propose({ worker: 'Cora', directive: 'build the Curfew page', turn: 1 });
check('something is pending after propose', gate.hasPending);

// Starting on the SAME turn it was proposed → refused (this is the whole point).
const sameTurn = gate.start({ turn: 1 });
check('cannot start in the same turn as the proposal', !sameTurn.ok && sameTurn.reason === 'same-turn');
check('proposal survives a refused same-turn start', gate.hasPending);

// Starting on a background/non-Director turn → refused.
const bgTurn = gate.start({ turn: null });
check('cannot start on a non-Director turn', !bgTurn.ok && bgTurn.reason === 'not-director-turn');

// Starting on a LATER Director turn (the confirmation) → allowed, returns the task.
const ok = gate.start({ turn: 2 });
check('starts on a later Director turn', ok.ok && ok.task.worker === 'Cora' && ok.task.directive === 'build the Curfew page');
check('proposal consumed after a successful start', !gate.hasPending);

// Starting again with nothing pending → refused.
const again = gate.start({ turn: 3 });
check('nothing to start once consumed', !again.ok && again.reason === 'nothing-proposed');

// Cancel drops a pending proposal so it can never start.
gate.propose({ worker: 'Theo', directive: 'x', turn: 4 });
gate.cancel();
check('cancel clears the proposal', !gate.hasPending && !gate.start({ turn: 5 }).ok);

// Latest proposal wins (re-proposing overwrites).
gate.propose({ worker: 'Cora', directive: 'first', turn: 6 });
gate.propose({ worker: 'Nia', directive: 'second', turn: 6 });
const latest = gate.start({ turn: 7 });
check('re-proposing replaces the pending plan', latest.ok && latest.task.worker === 'Nia' && latest.task.directive === 'second');

console.log('\n=================== RESULTS ===================');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.label}`);
console.log('==============================================');
const pass = checks.every((c) => c.ok);
console.log(pass ? '✅ CONFIRMATION GATE HOLDS (no build without a separate Director go-ahead)' : '❌ gate broken');
process.exit(pass ? 0 : 1);
