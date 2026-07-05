// Walkie end-to-end loop test — "the mannequin breathes".
// Spawns the local broker (the phone's on-ramp), runs the EM conductor attached to the
// SAME workspace, and drives a simulated phone over the broker (WS /ws + POST /api/send).
// Proves: phone directive → conductor dispatches a worker → builds + verifies → curated
// result surfaces back ON THE PHONE.
//
//   node test/e2e-loop.mjs            # full loop: spawns a real Claude (sonnet) worker
//   WALKIE_E2E_DRY=1 node test/e2e-loop.mjs   # $0 plumbing-only: no worker, EM echoes a canned ✅
//
// The phone is simulated exactly as the iOS app will behave per docs/local-broker.md.

import { Conductor } from '../src/conductor.mjs';
import { loadWorkspaceKey } from '../src/broker.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from '../node_modules/ws/wrapper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.env.WALKIE_E2E_DRY === '1';
const PORT = 3899;                 // off the default 3889 so it never collides with a real broker
const API_KEY = 'br_e2e';
const WORK = '/tmp/walkie-e2e-work';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const oneLine = (s) => (s ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, 200);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// --- 1. spawn the broker (bound to localhost for the test) ---
log('spawning broker on 127.0.0.1:' + PORT + '…');
const BROKER_STATE = '/tmp/walkie-e2e-relay';
rmSync(BROKER_STATE, { recursive: true, force: true });
const broker = spawn(process.execPath, [join(HERE, '..', 'src', 'broker.mjs')], {
  env: { ...process.env, WALKIE_BROKER_BIND: '127.0.0.1', WALKIE_BROKER_PORT: String(PORT), WALKIE_BROKER_API_KEY: API_KEY, WALKIE_BROKER_STATE_DIR: BROKER_STATE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://127.0.0.1:${PORT}`;
async function waitForBroker(ms = 25000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const r = await fetch(`${base}/api/status`, { headers: { 'x-api-key': API_KEY } }).catch(() => null);
    if (r && r.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('broker did not come up');
}
await waitForBroker();
log('broker up.');

// --- 2. conductor attaches to the shared workspace, watches #standup ---
function snapshot(dir) {
  const m = new Map();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) { try { m.set(f, statSync(join(dir, f)).mtimeMs); } catch {} }
  return m;
}
const changedSince = (before, dir) => { const a = snapshot(dir); for (const [f, t] of a) if (!before.has(f) || before.get(f) !== t) return true; return false; };

const c = new Conductor({ workspaceKey: loadWorkspaceKey(), emName: 'Mara', cwd: WORK, log });
await c.start();
c.watch({
  directiveFrom: 'Director',
  onDirective: async (directive) => {
    await c.say(`👋 on it: ${oneLine(directive)}`);
    if (DRY) { await c.say(`✅ (dry) would have built: ${oneLine(directive)}`); return; }
    const before = snapshot(WORK);
    const r = await c.dispatch({ name: 'Theo', engine: 'claude', model: 'sonnet', directive, verify: () => changedSince(before, WORK) });
    await c.say(r.verified ? `✅ ${r.from}: ${oneLine(r.text)}` : `⚠️ ${r.from} blocked: ${oneLine(r.text)}`);
  },
});

// --- 3. the simulated phone: a broker client (WS subscribe + /api/send), per local-broker.md ---
const heard = [];
let sawAck = false, sawResult = false;
const phone = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-api-key': API_KEY } });
await new Promise((resolve, reject) => {
  phone.on('open', resolve);
  phone.on('error', reject);
});
phone.on('message', (d) => {
  const f = JSON.parse(d.toString());
  const from = f.from ?? '?';
  const body = (f.body ?? f.text ?? '').toString();
  if (from === 'Mara' || /on it|✅|⚠️|blocked/.test(body)) {
    heard.push({ from, body });
    log(`  📱 phone hears ← ${from}: ${body}`);
    if (body.includes('on it')) sawAck = true;
    if (body.startsWith('✅') || body.includes('blocked')) sawResult = true;
  }
});
log('phone subscribed to #standup via broker /ws.');
await new Promise((r) => setTimeout(r, 1200));

// --- 4. the phone speaks a directive ---
const directive = DRY
  ? 'Say hello to the team.'
  : 'Create a file named hello.txt whose contents are exactly the single word: walkie';
log(`📱 phone → directive: "${directive}"`);
const res = await fetch(`${base}/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ from: 'Director', to: '#standup', text: directive }),
});
log('  /api/send →', res.status);

// --- 5. wait for the surfaced result to land on the phone ---
const deadline = Date.now() + (DRY ? 15000 : 180000);
while (Date.now() < deadline && !(sawAck && sawResult)) await new Promise((r) => setTimeout(r, 500));

const fileOk = DRY ? true : existsSync(join(WORK, 'hello.txt'));
log('=================== RESULTS ===================');
log('  phone heard EM ack ("on it"):     ', sawAck ? '✅' : '❌');
log('  phone heard surfaced result:      ', sawResult ? '✅' : '❌');
log('  worker actually produced the file:', fileOk ? '✅' : (DRY ? 'n/a' : '❌'));
log('==============================================');

try { phone.close(); } catch {}
broker.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 800));
const pass = sawAck && sawResult && fileOk;
log(pass ? '✅ THE MANNEQUIN BREATHES — full loop closed' : '❌ loop incomplete');
process.exit(pass ? 0 : 1);
