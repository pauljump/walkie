// APNs push: tell the phone when a session needs you (an ask) or finishes a long turn, but only
// while the app isn't open in front of you. Uses a token-based APNs key (.p8), HTTP/2, and an
// ES256 JWT signed with node:crypto, so there's no dependency.
//
// Config (central secrets only):
//   ~/.secrets/monorepo.env   APNS_KEY_ID, APNS_TEAM_ID
//   ~/.secrets/vendor/apple/AuthKey_<APNS_KEY_ID>.p8
// Device tokens (not credentials) live in ~/.walkie/devices.json.
// An APNs key belongs to the app's developer team, so push works only on a bridge that has one; a
// bridge without it reports push: false on /api/status and the phone never asks for permission.

import { connect } from 'node:http2';
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';

const TOPIC = 'cc.walkie.app';
const WHO = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok' };
const LONG_TURN_MS = 20_000;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function apnsJwt({ keyId, teamId, key, now = Math.floor(Date.now() / 1000) }) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const body = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

export function loadApnsConfig(home = homedir()) {
  try {
    const env = readFileSync(join(home, '.secrets', 'monorepo.env'), 'utf8');
    const val = (k) => env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=['"]?([^'"\\n]+)`, 'm'))?.[1]?.trim();
    const keyId = val('APNS_KEY_ID');
    if (!keyId) return null;
    const keyPath = join(home, '.secrets', 'vendor', 'apple', `AuthKey_${keyId}.p8`);
    if (!existsSync(keyPath)) return null;
    const teamId = val('APNS_TEAM_ID');
    if (!teamId) return null;
    return { keyId, teamId, key: readFileSync(keyPath, 'utf8') };
  } catch { return null; }
}

// What to say for a hub event, or null for "not worth a buzz".
export function notificationFor(session, event, { turnMs = 0 } = {}) {
  const where = basename(session.cwd || '') || session.agent;
  const who = WHO[session.agent] || session.agent;
  if (event.kind === 'ask') {
    return {
      title: `${who} needs you · ${where}`,
      body: event.type === 'question' ? (event.questions?.[0]?.question || 'Has a question') : `Wants to run: ${event.title || 'a tool'}`,
      category: 'ASK',
    };
  }
  if (event.kind === 'result' && turnMs >= LONG_TURN_MS) {
    return {
      title: `${who} ${event.ok === false ? 'stopped' : 'finished'} · ${where}`,
      body: session.title || (event.ok === false ? event.text || 'Stopped' : 'Done'),
      category: 'DONE',
    };
  }
  return null;
}

export function makePush({ hub, isForeground = () => false, config = loadApnsConfig(), devicesPath = join(homedir(), '.walkie', 'devices.json'), log = () => {}, send } = {}) {
  let devices = [];
  try { devices = JSON.parse(readFileSync(devicesPath, 'utf8')).devices || []; } catch {}
  const turnStart = new Map(); // session key → ms the turn started
  let jwt = null; let jwtAt = 0;
  const clients = {};

  function save() {
    mkdirSync(dirname(devicesPath), { recursive: true, mode: 0o700 });
    writeFileSync(devicesPath, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  }

  function token() {
    if (!jwt || Date.now() - jwtAt > 40 * 60 * 1000) { jwt = apnsJwt(config); jwtAt = Date.now(); }
    return jwt;
  }

  function deliver(device, payload) {
    const host = device.env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    return new Promise((resolve) => {
      let client = clients[host];
      if (!client || client.closed || client.destroyed) {
        client = clients[host] = connect(host);
        client.on('error', (err) => { log(`[push] ${host}: ${err.message}`); client.destroy(); });
        client.unref?.();
      }
      const req = client.request({
        ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${token()}`, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10',
        'content-type': 'application/json',
      });
      let data = '';
      req.on('response', (h) => { req.on('end', () => resolve({ status: h[':status'], body: data })); });
      req.on('data', (c) => { data += c; });
      req.on('error', (err) => resolve({ status: 0, body: err.message }));
      req.setTimeout(15_000, () => { req.close(); resolve({ status: 0, body: 'APNs timed out' }); });
      req.end(JSON.stringify(payload));
    });
  }

  async function notify(session, n) {
    await deliverAll({
      aps: { alert: { title: n.title, body: n.body.slice(0, 180) }, sound: 'default', category: n.category, 'thread-id': session.key },
      key: session.key, cwd: session.cwd, agent: session.agent,
    });
  }

  async function deliverAll(payload) {
    for (const d of [...devices]) {
      const r = await (send ? send(d, payload) : deliver(d, payload));
      if (r.status === 410 || (r.status === 400 && /BadDeviceToken/.test(r.body))) {
        devices = devices.filter((x) => x.token !== d.token); save();
        log(`[push] dropped stale device ${d.token.slice(0, 8)}…`);
      } else if (r.status !== 200) log(`[push] APNs ${r.status}: ${r.body}`);
    }
  }

  hub.on('frame', (frame) => {
    if (frame.type === 'status' && frame.status === 'running' && !turnStart.has(frame.key)) turnStart.set(frame.key, Date.now());
    if (frame.type !== 'event') return;
    const session = hub.get(frame.key);
    if (!session) return;
    const turnMs = frame.event.kind === 'result' ? Date.now() - (turnStart.get(frame.key) ?? Date.now()) : 0;
    if (frame.event.kind === 'result') turnStart.delete(frame.key);
    if (!config || !devices.length || isForeground()) return;
    const n = notificationFor(session, frame.event, { turnMs });
    if (n) notify(session, n).catch((err) => log(`[push] ${err.message}`));
  });

  return {
    enabled: () => Boolean(config),
    register({ token, env }) {
      if (!/^[0-9a-f]{32,200}$/i.test(String(token || ''))) throw Object.assign(new Error('bad device token'), { status: 400 });
      devices = devices.filter((d) => d.token !== token);
      devices.push({ token, env: env === 'sandbox' ? 'sandbox' : 'production', at: Date.now() });
      save();
      return { ok: true, pushEnabled: Boolean(config) };
    },
  };
}
