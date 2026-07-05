// Proof the retry layer rides out a transient blip but never masks a real error. $0, pure logic.
//   node test/retry.mjs

import { isTransient, withRetry } from '../src/retry.mjs';

const checks = [];
const check = (label, ok) => checks.push({ label, ok });
const nosleep = () => Promise.resolve(); // no real delay in the test

// ── classification ──────────────────────────────────────────────────────────────────────────
check('500 status is transient', isTransient({ status: 500 }));
check('"Internal server error" message is transient', isTransient(new Error('500 {"type":"api_error","message":"Internal server error"}')));
check('429 is transient', isTransient({ status: 429 }));
check('ECONNRESET is transient', isTransient(new Error('read ECONNRESET')));
check('400 bad request is NOT transient', !isTransient({ status: 400 }));
check('401 auth is NOT transient', !isTransient({ status: 401 }));
check('a plain bug is NOT transient', !isTransient(new TypeError('x is not a function')));

// ── withRetry behavior ──────────────────────────────────────────────────────────────────────
// Succeeds on the first try → called once, no retries.
let calls = 0;
const okFirst = await withRetry(() => { calls++; return 'done'; }, { sleep: nosleep });
check('returns value on first success', okFirst === 'done' && calls === 1);

// Two transient failures then success → recovers on the 3rd attempt.
calls = 0;
const recovered = await withRetry(
  () => { calls++; if (calls < 3) { const e = new Error('Internal server error'); e.status = 500; throw e; } return 'recovered'; },
  { attempts: 3, sleep: nosleep },
);
check('recovers after transient failures', recovered === 'recovered' && calls === 3);

// All attempts transient-fail → throws the last error after exactly `attempts` tries.
calls = 0;
let threw = false;
try {
  await withRetry(() => { calls++; const e = new Error('overloaded'); e.status = 529; throw e; }, { attempts: 3, sleep: nosleep });
} catch { threw = true; }
check('gives up after attempts exhausted', threw && calls === 3);

// A non-transient error → thrown immediately, NOT retried (no wasted calls/money).
calls = 0;
threw = false;
try {
  await withRetry(() => { calls++; const e = new Error('bad request'); e.status = 400; throw e; }, { attempts: 5, sleep: nosleep });
} catch { threw = true; }
check('does NOT retry a non-transient error', threw && calls === 1);

console.log('\n=================== RESULTS ===================');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.label}`);
console.log('==============================================');
const pass = checks.every((c) => c.ok);
console.log(pass ? '✅ RETRY LAYER WORKS (rides transient blips, never masks real errors)' : '❌ retry broken');
process.exit(pass ? 0 : 1);
