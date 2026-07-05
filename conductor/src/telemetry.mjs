// Beta telemetry — COUNTS, NEVER CONTENT.
//
// Walkie is self-host: this code runs on the OPERATOR'S OWN Mac, so anything sent from here is
// their machine phoning home. The rules, non-negotiable:
//   1. Counts only. Event names + booleans + an anonymous instance id. NEVER the directive text,
//      NEVER build output, NEVER repo names, paths, PR titles/URLs, or anything the operator typed
//      or spoke. If a future event needs a payload, the payload is a number or a boolean.
//   2. OFF unless the config says otherwise (`telemetry: true`). The baked default is FALSE —
//      the guided installer writes `true` WITH a spoken disclosure and points at the off switch.
//      Tests and bare checkouts therefore never phone home.
//   3. Fire-and-forget. A telemetry failure may never break, slow, or log-spam the product:
//      3s timeout, every error swallowed, no retries.
//
// The instance id is a random UUID minted once into ~/.walkie/instance-id — it identifies an
// INSTALL for counting ("12 instances walked this week"), not a person or a machine.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';

const INGEST = 'https://pulse.polyfeeds.dev/api/ingest';
const PROPERTY = 'walkie-beta';

function enabled(cfg) {
  if (process.env.WALKIE_TELEMETRY === '0') return false;   // hard off, wins over config
  return (cfg ?? loadConfig()).telemetry === true;          // explicit opt-in only
}

// Mint-once anonymous install id. Any failure (weird permissions, read-only fs) degrades to
// 'unknown' rather than blocking the caller.
export function instanceId(stateDir = join(homedir(), '.walkie')) {
  try {
    const p = join(stateDir, 'instance-id');
    try { return readFileSync(p, 'utf8').trim(); } catch {}
    const id = randomUUID();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, id + '\n');
    return id;
  } catch {
    return 'unknown';
  }
}

// track('build_done', { ok: true }) — fire-and-forget; returns immediately.
// props values are coerced to numbers/booleans only, enforcing rule #1 at the seam.
export function track(event, props = {}, { cfg } = {}) {
  try {
    const c = cfg ?? loadConfig();
    if (!enabled(c)) return;
    const clean = {};
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    }
    const body = JSON.stringify({
      event,
      property: PROPERTY,
      path: `/${event}`,
      props: { ...clean, instance: instanceId(c.stateDir) },
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },  // CORS-safelisted shape pulse expects
      body,
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => clearTimeout(timer));
  } catch {
    /* telemetry must never break the product */
  }
}
