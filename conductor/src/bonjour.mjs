// Bonjour advertise — so the phone can DISCOVER the Mac on the LAN with zero typing.
//
// The running backend advertises itself as `_walkie._tcp` on the local network. The iOS app
// (task #14, out of scope here) browses that service type via NWBrowser and gets host+port for
// free — the user never types an address. This is the LAN convenience twin of the Tailscale name
// (which handles OFF-LAN); Bonjour is LAN-only.
//
// Dependency-free path: shell out to the system `dns-sd` binary (ships with macOS at
// /usr/bin/dns-sd). `dns-sd -R` registers a service and MUST STAY RUNNING to keep the
// advertisement alive — it DEREGISTERS the moment its process exits. So we run it as a long-lived,
// NON-detached child of the conductor and reap it on parent exit. Under the launchd service the
// conductor is long-lived, so the advertisement lives exactly as long as Walkie is up.
//
// The TXT record is broadcast IN THE CLEAR on the LAN, so it carries NO secret — never the broker
// key. The phone gets host+port from Bonjour and still needs the client key from the QR or a typed
// entry. That keeps discovery convenient without leaking the shared secret to every device on the
// network.
//
// Advertisement is a CONVENIENCE, never load-bearing: if dns-sd is missing or errors, we log one
// line and continue. The phone can always connect by typing the address (Settings) or scanning the
// installer QR.
//
// Fallback (documented, NOT built — dns-sd is present): a ~60-line mDNS responder on node:dgram
// answering PTR/SRV/TXT for _walkie._tcp.local over UDP 224.0.0.251:5353. This is the smallest
// zero-binary alternative if dns-sd ever proves unavailable.

import { spawn } from 'node:child_process';

// The service type the iOS app will browse. Must match EXACTLY on both halves (Info.plist
// NSBonjourServices = ["_walkie._tcp"] + NWBrowser) or discovery yields zero results with no error.
export const SERVICE_TYPE = '_walkie._tcp';

// Sanitize a friendly instance label. dns-sd takes the instance name as one arg; keep it printable
// and bounded. Bonjour instance names are UTF-8 and may contain spaces/apostrophes, so this is
// light-touch: trim, collapse whitespace, cap length, fall back to "Walkie".
function instanceName(directorName) {
  const base = String(directorName || '').trim();
  const label = base ? `${base}'s Walkie` : 'Walkie';
  return label.replace(/\s+/g, ' ').slice(0, 63) || 'Walkie';
}

// advertiseWalkie({ port, name, txt, log }) -> { stop() }
//   port : the broker port to advertise (cfg.brokerPort).
//   name : the Director's name; becomes "<name>'s Walkie" so two instances on one LAN disambiguate.
//   txt  : extra TXT key=value tokens (defaults below). NEVER put the broker key here.
//   log  : line logger.
export function advertiseWalkie({ port, name, txt = {}, log = () => {} } = {}) {
  const label = instanceName(name);
  const p = Number(port) || 3889;
  // TXT records: each "key=value" is its own arg to dns-sd. `v` is a version tag so a future app can
  // reject an incompatible advertiser; `path` tells the app the WS route; `apikeyhint` signals the
  // key prefix without leaking the key. NO secret goes in here (broadcast in the clear).
  const txtRecords = { v: '1', path: '/ws', apikeyhint: 'br', ...txt };
  const txtArgs = Object.entries(txtRecords).map(([k, val]) => `${k}=${val}`);

  let child = null;
  let stopped = false;

  try {
    // spawn (NOT execFile) so it stays resident; detached:false so it dies with the parent; stdout
    // ignored, stderr piped to the debug log. `dns-sd -R "<name>" _walkie._tcp local <port> <txt...>`
    child = spawn(
      'dns-sd',
      ['-R', label, SERVICE_TYPE, 'local', String(p), ...txtArgs],
      { detached: false, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (d) => log(`[bonjour] ${String(d).trim()}`));
    child.on('error', (err) => {
      // ENOENT etc. — dns-sd not runnable. Convenience only; do not crash the conductor.
      log(`[bonjour] advertise unavailable (${err.message}) — the phone can still connect by typing the address`);
      child = null;
    });
    child.on('exit', (code, sig) => {
      if (!stopped) log(`[bonjour] advertiser exited (code ${code ?? '-'}${sig ? `, ${sig}` : ''}) — discovery off; typed address still works`);
    });
    log(`[bonjour] advertising "${label}" as ${SERVICE_TYPE} on port ${p} (LAN discovery; no key in the broadcast)`);
  } catch (err) {
    // spawn itself threw (e.g. binary missing on a non-mac). Never load-bearing.
    log(`[bonjour] advertise unavailable (${err.message}) — the phone can still connect by typing the address`);
    child = null;
  }

  return {
    stop() {
      stopped = true;
      if (child) { try { child.kill(); } catch {} child = null; }
    },
  };
}
