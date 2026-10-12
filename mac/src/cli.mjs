#!/usr/bin/env node
// walkie serve   run the bridge (launchd runs this)
// walkie pair    print the pairing link + QR for the iPhone app

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from './hub.mjs';
import { makeClaude, findClaude } from './claude.mjs';
import { makeCodex } from './codex.mjs';
import { makeAgy } from './agy.mjs';
import { makeAcp } from './acp.mjs';
import { makeUsage } from './usage.mjs';
import { makeModels } from './models.mjs';
import { makePush } from './push.mjs';
import { makeServer, miniAdmission } from './server.mjs';
import { makeCustomize } from './customize.mjs';

const SECRETS = join(homedir(), '.secrets', 'monorepo.env');
const KEY_FILE = join(homedir(), '.walkie', 'key');
const PORT = Number(process.env.WALKIE_PORT || 3889);
const BIND = process.env.WALKIE_BIND || '0.0.0.0';
const ROOTS = (process.env.WALKIE_PROJECT_ROOTS || join(homedir(), 'projects')).split(':');

// The one shared secret between phone and Mac. In order: the environment, ~/.secrets/monorepo.env
// (how this Mac keeps secrets), then ~/.walkie/key, which is made on first run so `walkie pair` just works.
function loadKey() {
  if (process.env.WALKIE_BROKER_API_KEY) return process.env.WALKIE_BROKER_API_KEY;
  try {
    const line = readFileSync(SECRETS, 'utf8').split('\n').find((l) => /^\s*(export\s+)?WALKIE_BROKER_API_KEY=/.test(l));
    const key = line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (key) return key;
  } catch {}
  try { const k = readFileSync(KEY_FILE, 'utf8').trim(); if (k) return k; } catch {}
  const key = randomBytes(24).toString('hex');
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
  return key;
}

// The CLIs must run on the Mac's own logins (Claude, ChatGPT, Google and X subscriptions), exactly as
// at the desk. A stray API key in the environment would silently switch them to metered billing.
function scrubEnv() {
  for (const k of Object.keys(process.env)) {
    if (['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY'].includes(k) || k.startsWith('WALKIE_') && k.endsWith('KEY')) delete process.env[k];
  }
}

// Where the phone should reach this Mac: its Tailscale name when there is one (works anywhere),
// else its local name (same Wi-Fi only).
function tailnetHost() {
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const self = JSON.parse(execFileSync(bin, ['status', '--self', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).Self;
      if (self?.DNSName) return self.DNSName.replace(/\.$/, '');
    } catch {}
  }
  try { return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`; } catch { return 'localhost'; }
}

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const cmd = process.argv[2] || 'serve';

if (cmd === 'serve') {
  const apiKey = loadKey();
  scrubEnv();
  // One bad callback must not take every live session down with it. Log it and keep serving; launchd
  // restarts the bridge if it ever does exit.
  process.on('unhandledRejection', (err) => log(`[unhandled] ${err?.stack || err}`));
  process.on('uncaughtException', (err) => log(`[uncaught] ${err?.stack || err}`));
  const hub = new Hub();
  const adapters = {
    claude: makeClaude({ hub, log }),
    codex: makeCodex({ hub, log }),
    agy: makeAgy({ hub, log }),
    grok: makeAcp({ hub, agent: 'grok', label: 'Grok', command: ['grok', 'agent', 'stdio'], log }),
  };
  let server;
  const push = makePush({ hub, isForeground: () => server?.isForeground() ?? false, log });
  const usage = makeUsage({ hub, codexCall: adapters.codex.request, claudePath: findClaude(), log });
  const models = makeModels({ codexCall: adapters.codex.request, claudePath: findClaude() });
  const customize = makeCustomize({ onChange: () => hub.emit('frame', { type: 'customize' }), log });
  server = makeServer({ hub, adapters, apiKey, projectRoots: ROOTS, push, usage, models, customize, admission: miniAdmission, log });
  if (!push.enabled()) log('push off: add APNS_KEY_ID to ~/.secrets/monorepo.env and the .p8 to ~/.secrets/vendor/apple/');
  server.on('error', (err) => { log(`[listen] ${err.message}`); process.exit(1); });
  server.listen(PORT, BIND, () => log(`walkie bridge on ${BIND}:${PORT} (projects: ${ROOTS.join(', ')})`));
  const stop = () => { for (const a of Object.values(adapters)) a.stop?.(); server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else if (cmd === 'pair') {
  const host = process.argv[3] || tailnetHost();
  const url = `walkie://pair?host=${encodeURIComponent(host)}&port=${PORT}&key=${encodeURIComponent(loadKey())}`;
  try { execFileSync('qrencode', ['-t', 'ansiutf8', url], { stdio: 'inherit' }); } catch { console.log('(brew install qrencode to get a QR code here)'); }
  console.log(`\nOpen this on your iPhone, or paste it into Walkie → Paste pairing link:\n${url}\n`);
  if (!/\.ts\.net$/.test(host)) console.log('No Tailscale found, so this address only works on the same Wi-Fi. Install Tailscale on both devices to use Walkie anywhere.\n');
} else {
  console.error('usage: walkie serve | walkie pair [host]');
  process.exit(1);
}
