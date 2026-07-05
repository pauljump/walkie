// $0 smoke test for the SELF-HOST local transport — no paid LLM, no @agent-relay/*, no hosted relay.
//
// Proves the two new pieces end to end against the exact wire the iOS app speaks:
//   A. LocalBus is a byte-compatible drop-in for the broker's phone surface:
//      - GET /api/status: UNAUTHENTICATED readiness (200 with no/wrong key; no secrets echoed)
//      - POST /api/send: STILL authed (bad key → 401); empty-text ping → 200 (no publish);
//        bare "to" → 404; valid → 200
//   C. Readiness via makeBus: maraReady/sandboxReady flip LIVE with the config (bus.mjs closure)
//      - GET /ws (x-api-key): a WS client receives a published frame with {from, body, target, seq}
//      - reconnect → full history REPLAY with ORIGINAL seqs (high-water dedup drops the backlog)
//   B. The direct jailed spawner surfaces a build's DONE line ON the bus, using a FAKE claude that
//      just prints DONE (never a real paid build). Runs through LocalConductor.dispatch, so it also
//      proves the Bus seam + spawner wiring the live conductor uses.
//
//   node test/local-bus.mjs
//
// The WS client is Node 22's built-in global WebSocket (no `ws` dependency) — same client the phone
// models (BrokerClient decodes the same frames).

import { LocalBus } from '../src/local-bus.mjs';
import { makeBus } from '../src/bus.mjs';
import { writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let fail = 0;
const ok = (c, m) => { console.log(c ? '  PASS' : '  FAIL', m); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsOpen = (url, key) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers: { 'x-api-key': key } });
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error('ws error: ' + (e?.message || e)));
  });

// ── A. LocalBus wire compatibility ───────────────────────────────────────────────────────────
console.log('\n[A] LocalBus wire compatibility (the iOS app on-ramp)');
const KEY = 'br_smoke';
const bus = new LocalBus({ bind: '127.0.0.1', port: 0, apiKey: KEY, log: () => {} });
await bus.start();
const PORT = bus.port;
const base = `http://127.0.0.1:${PORT}`;
const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
const post = (body, key = KEY) =>
  fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });

// status is UNAUTHENTICATED now (readiness only, no secrets) — readable with NO key and with a
// WRONG key, so the app can render its readiness screen before the user has typed/scanned anything.
ok((await fetch(`${base}/api/status`)).status === 200, '/api/status with NO key → 200 (unauth readiness)');
ok((await fetch(`${base}/api/status`, { headers: { 'x-api-key': 'WRONG' } })).status === 200, '/api/status wrong key → still 200 (never 401)');
{
  const s = await (await fetch(`${base}/api/status`)).json();
  ok(s.ok === true && s.busUp === true, 'status shape: ok + busUp true (server alive)');
  ok(typeof s.seq === 'number' && typeof s.clients === 'number', 'status shape: seq + clients are numbers');
  // This LocalBus was built directly (no readiness provider injected), so the readiness keys default
  // to the empty object — no secret is ever present regardless. Assert nothing secret leaks.
  ok(!JSON.stringify(s).includes(KEY), 'status NEVER echoes the api key');
}

// send auth + channel rules — /api/send stays AUTHED (the auth split is preserved).
ok((await post({ from: 'Director', to: '#standup', text: 'hi' }, 'WRONG')).status === 401, '/api/send bad key → 401 (auth split: send still authed)');
ok((await post({ from: 'Director', to: '#standup', text: '' })).status === 200, '/api/send empty ping → 200');
ok(bus.history.length === 0, 'empty ping did NOT publish (history still empty)');
ok((await post({ from: 'Director', to: 'agentname', text: 'hi' })).status === 404, '/api/send bare "to" → 404 (agent DM parity)');

// WS roundtrip: POST a directive, receive it on a /ws client
const heard = [];
const wsA = await wsOpen(wsUrl, KEY);
wsA.onmessage = (ev) => heard.push(JSON.parse(ev.data));
wsA.send('{"type":"subscribe","channels":["standup","work"]}'); // must be accept-and-ignored
await sleep(80);
ok(wsA.readyState === 1, 'socket stays open after the subscribe control frame');

ok((await post({ from: 'Director', to: '#standup', text: 'ship the thing' })).status === 200, '/api/send valid directive → 200');
await sleep(120);
const frame = heard.find((f) => f.body === 'ship the thing');
ok(!!frame, 'WS client received the published directive');
ok(frame?.from === 'Director', 'frame.from preserved verbatim ("Director")');
ok(frame?.target === '#standup', 'frame.target stamped "#standup" for app routing');
ok(typeof frame?.seq === 'number', 'frame carries an integer seq');

// Mara/standup + engineer/work frames, then reconnect → replay with ORIGINAL seqs
bus.publish({ from: 'Mara', text: 'on it', channel: 'standup' });
bus.publish({ from: 'Theo', text: 'building', channel: 'work' });
await sleep(60);
const maxSeq = bus.seq;
const replayed = [];
const wsB = await wsOpen(wsUrl, KEY);
wsB.onmessage = (ev) => replayed.push(JSON.parse(ev.data));
await sleep(150);
ok(replayed.length === bus.history.length, `reconnect replays full history (${replayed.length} == ${bus.history.length})`);
const seqs = replayed.map((f) => f.seq);
ok(Math.max(...seqs) === maxSeq, `replayed seqs are the ORIGINAL seqs (max ${Math.max(...seqs)} == ${maxSeq}, not renumbered)`);
ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'replayed seqs are monotonically increasing');
ok(replayed.filter((f) => f.seq > maxSeq).length === 0, 'a client at high-water=maxSeq drops the WHOLE backlog (no re-speak)');

wsA.close(); wsB.close();
await bus.stop();

// ── B. Direct jailed spawner → DONE surfaces on the bus (fake claude, $0) ──────────────────────
console.log('\n[B] direct jailed spawner → DONE surfaces on the bus (FAKE claude, no paid call)');

// A fake claude that echoes its jail env, writes into the sandbox dir, and prints a DONE line.
const FAKE = '/tmp/walkie-localbus-fake-claude.sh';
writeFileSync(
  FAKE,
  '#!/bin/bash\n' +
  'echo "fake-claude invoked (never a real build)"\n' +
  'echo "WORKER=${WALKIE_WORKER_NAME} SANDBOX=${WALKIE_SANDBOX_DIR} DENY=${WALKIE_PROFILE_DENY}"\n' +
  'if [ -n "${WALKIE_SANDBOX_DIR}" ]; then echo hi > "${WALKIE_SANDBOX_DIR}/made.txt"; fi\n' +
  'echo "DONE: fake build created made.txt"\n',
);
chmodSync(FAKE, 0o755);

const WT = '/tmp/walkie-localbus-wt';
rmSync(WT, { recursive: true, force: true });
mkdirSync(WT, { recursive: true });

// Build a LocalConductor via the SAME seam the live conductor uses. jail OFF so the shim execs the
// fake directly (sandbox-exec allow/deny is covered separately by the jail smoke test); realClaude
// points at the fake so NO real claude is ever invoked.
const cfg = { transport: 'local', brokerBind: '127.0.0.1', brokerPort: 0, brokerApiKey: KEY, directorName: 'Director', jailProfile: false, stateDir: '/tmp/walkie-localbus-state' };
const c = await makeBus(cfg, { cwd: WT, log: () => {}, build: { jail: false, realClaude: FAKE } });
await c.start();

// Watch the bus for the tee'd #build output + capture what dispatch surfaces.
const buildLines = [];
c.bus.on('message', ({ channel, text }) => { if (channel === 'build') buildLines.push(text); });

const result = await c.dispatch({
  name: 'TheoHands0001', engine: 'claude', directive: 'make a file',
  task: 'make a file', channel: 'build', cwd: WT,
  verify: () => existsSync(join(WT, 'made.txt')), // filesystem gate, exactly like room.mjs
  timeoutMs: 15000,
});

ok(result.verified === true, 'dispatch verified via filesystem gate (build.hasChanges-style)');
ok((result.text || '').includes('DONE'), `dispatch surfaced the DONE line ("${result.text}")`);
ok(result.kind === 'review', 'surfaced kind = review (verified)');
ok(buildLines.some((l) => l.includes('WORKER=TheoHands0001')), 'raw build output tee\'d onto #build (Team Room feed)');
ok(buildLines.some((l) => l.includes(`SANDBOX=${WT}`)), 'jail env WALKIE_SANDBOX_DIR reached the child (the closed gap)');
ok(existsSync(join(WT, 'made.txt')), 'the fake build actually wrote into the sandbox worktree');

// codex is not on the direct spawner — it must error clearly on the local path.
let codexErr = null;
try { await c.dispatch({ name: 'X', engine: 'codex', directive: 'y', task: 'y', cwd: WT }); }
catch (e) { codexErr = e.message; }
ok(codexErr && /codex/i.test(codexErr) && /agent-relay/i.test(codexErr), 'codex on local transport errors with a clean TODO pointer to agent-relay');

await c.stop();

// ── C. Readiness closure via makeBus — maraReady/sandboxReady flip with the config ──────────────
// Proves the GET /api/status readiness computed in bus.mjs (from cfg + validateConfig) is real: it
// re-reads config LIVE per request, so flipping the env flips the booleans + needs. $0, no key.
console.log('\n[C] /api/status readiness reflects the live config (maraReady / sandboxReady)');
const { clearConfigCache } = await import('../src/config.mjs');

// A temp config file the readiness closure will loadConfig({fresh:true}) from. We drive it with
// WALKIE_* env (which the config layer honors) so we don't touch the user's real ~/.walkie.
const RDIR = '/tmp/walkie-localbus-readiness';
rmSync(RDIR, { recursive: true, force: true });
mkdirSync(RDIR, { recursive: true });
const CFG_PATH = join(RDIR, 'config.json');
writeFileSync(CFG_PATH, '{}\n'); // empty file → all defaults; env supplies the rest

// State BEFORE: no anthropic key, sandbox dir without a .git → both NOT ready.
const NO_GIT_DIR = join(RDIR, 'no-git');
mkdirSync(NO_GIT_DIR, { recursive: true });
process.env.WALKIE_CONFIG_PATH = CFG_PATH;
process.env.WALKIE_SANDBOX_DIR = NO_GIT_DIR;
delete process.env.WALKIE_ANTHROPIC_API_KEY;
clearConfigCache();

const rcfg = { transport: 'local', brokerBind: '127.0.0.1', brokerPort: 0, brokerApiKey: KEY };
const rc = await makeBus(rcfg, { log: () => {} });
await rc.start();
const rbase = `http://127.0.0.1:${rc.bus.port}`;
const status = async () => (await fetch(`${rbase}/api/status`)).json();

{
  const s = await status();
  ok(s.maraReady === false, 'maraReady false when no sk-ant- key is set');
  ok(s.sandboxReady === false, 'sandboxReady false when sandboxDir has no .git');
  ok(s.ready === false, 'aggregate ready false while either axis is unmet');
  ok(Array.isArray(s.needs) && s.needs.some((n) => /Anthropic/i.test(n)), 'needs names the missing voice key in plain copy');
  ok(s.needs.some((n) => /practice project/i.test(n)), 'needs names the missing practice project in plain copy');
  ok(s.transport === 'local', 'status reports the transport');
  ok(!JSON.stringify(s).includes(KEY), 'readiness NEVER echoes the broker key');
  // maraReady is a bare boolean here (no key set), and the "needs" copy may name the sk-ant- PREFIX
  // as an instruction — that is not a leak. The real invariant (a KEY VALUE never appears) is
  // asserted below, after we set a real-looking sk-ant- value.
}

// Flip BOTH axes: set a well-formed sk-ant- key and give the sandbox dir a real .git → both ready.
const GIT_DIR = join(RDIR, 'with-git');
mkdirSync(join(GIT_DIR, '.git'), { recursive: true }); // existsSync(join(dir,'.git')) is the gate
const FAKE_KEY_VALUE = 'sk-ant-smoketestZZZQ-not-a-real-key-value';
process.env.WALKIE_ANTHROPIC_API_KEY = FAKE_KEY_VALUE;
process.env.WALKIE_SANDBOX_DIR = GIT_DIR;
clearConfigCache();

{
  const s = await status(); // recomputed LIVE — no restart needed
  ok(s.maraReady === true, 'maraReady flips true once a sk-ant- key is present (live re-read)');
  ok(s.sandboxReady === true, 'sandboxReady flips true once .git exists (live re-read)');
  ok(s.ready === true, 'aggregate ready true when both axes are met');
  ok(Array.isArray(s.needs) && s.needs.length === 0, 'needs is empty when nothing is outstanding');
  // The real security invariant: the actual KEY VALUE never appears in the response, only the
  // boolean maraReady. (The instructional "sk-ant-…" prefix in `needs` copy is gone now anyway.)
  ok(!JSON.stringify(s).includes(FAKE_KEY_VALUE), 'readiness NEVER leaks the sk-ant- key VALUE');
}

await rc.stop();
// Clean the env we set so nothing leaks into other tests / the summary.
delete process.env.WALKIE_CONFIG_PATH;
delete process.env.WALKIE_SANDBOX_DIR;
delete process.env.WALKIE_ANTHROPIC_API_KEY;
clearConfigCache();
rmSync(RDIR, { recursive: true, force: true });

console.log(fail === 0 ? '\n✅ LOCAL TRANSPORT + SPAWNER + READINESS: ALL CHECKS PASS' : `\n❌ ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
