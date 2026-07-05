// Start the local Agent Relay broker — the phone's on-ramp into the shared Walkie
// workspace. The conductor attaches to the SAME workspace via the SDK (see run-live.mjs),
// so the Director (phone) and the EM converge on #standup. Proven bidirectional in the
// bridge scout (2026-06-13): phone /api/send → conductor SDK, and conductor → phone /ws.
//
//   node src/broker.mjs            # foreground; Ctrl-C to stop
//
// Config (self-host source of truth: ~/.walkie/config.json; WALKIE_* env still overrides):
//   workspaceKey   (WALKIE_RELAY_WORKSPACE_KEY)  rk_live_… workspace to join — required
//   brokerApiKey   (WALKIE_BROKER_API_KEY)       br_… client-auth key the phone presents
//   brokerBind     (WALKIE_BROKER_BIND)          bind address (0.0.0.0 → reachable over Tailscale)
//   brokerPort     (WALKIE_BROKER_PORT)          API port
//   brokerStateDir (WALKIE_BROKER_STATE_DIR)     broker persistent state

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, requireWorkspaceKey } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROKER_BIN = join(HERE, '..', 'node_modules', '@agent-relay', 'broker-darwin-arm64', 'bin', 'agent-relay-broker');

// Kept as a named export so run-live.mjs and the tests can pull the key the same way. Now sourced
// from the per-user config (with env override), not ~/.secrets — Walkie is self-host.
export function loadWorkspaceKey() {
  return requireWorkspaceKey();
}

// Start the broker. Guarded behind the main-module check below so that importing this
// file (e.g. run-live.mjs / e2e import loadWorkspaceKey) does NOT spawn a stray broker.
function startBroker() {
  const cfg = loadConfig();
  const WORKSPACE_KEY = requireWorkspaceKey(cfg);
  const API_KEY = cfg.brokerApiKey;
  const BIND = cfg.brokerBind;
  const PORT = String(cfg.brokerPort);
  const STATE = cfg.brokerStateDir; // stable, outside the repo (main-sync safe)
  mkdirSync(STATE, { recursive: true });

  console.log(`[walkie-broker] joining workspace ${WORKSPACE_KEY.slice(0, 14)}… on ${BIND}:${PORT}`);
  console.log(`[walkie-broker] state dir: ${STATE}   client key: ${API_KEY}`);
  console.log(`[walkie-broker] instance name "Director" → the phone's posts surface to the EM as from "Director"`);

  const broker = spawn(BROKER_BIN, [
    'init', '--persist',
    '--state-dir', STATE,
    '--api-bind', BIND, '--api-port', PORT,
    '--workspace-key', WORKSPACE_KEY,
    '--channels', 'standup,work',   // #standup = the voice line; #work = the team room the phone watches
    '--instance-name', 'Director',
  ], { env: { ...process.env, RELAY_BROKER_API_KEY: API_KEY }, stdio: ['ignore', 'inherit', 'inherit'] });

  const stop = () => { try { broker.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  broker.on('exit', (code) => { console.log(`[walkie-broker] exited (${code})`); process.exit(code ?? 0); });
}

// Only run the broker when invoked directly (`node src/broker.mjs`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  if ((cfg.transport || 'local') !== 'agent-relay') {
    // On the self-host 'local' transport the phone on-ramp is the built-in LocalBus, started by
    // run-live.mjs itself — there is NO separate hosted broker to run (and no rk_live_ key needed).
    // Starting the hosted broker here would either collide on the port or fail on the missing key.
    console.log('[walkie-broker] transport=local → no separate broker needed; the LocalBus WS+REST');
    console.log('[walkie-broker] server is built into `npm run live` (run-live.mjs). Nothing to start here.');
    console.log('[walkie-broker] (set WALKIE_TRANSPORT=agent-relay to run the hosted Agent Relay broker.)');
    process.exit(0);
  }
  startBroker();
}
