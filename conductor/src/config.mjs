// The single source of truth for a Walkie instance — one per-user config file, no scattered
// homedir()/env reads across the codebase. Walkie is a SELF-HOST product: the backend runs on
// the END USER's own Mac, so nothing here may be hardcoded to one person (no "pauljump/*", no
// "pauls-mac-mini" tailnet host, no dependency on ~/.secrets/monorepo.env for the shipped path).
//
// Layering (later wins):
//   1. baked defaults below (safe, non-Paul, work out of the box for a fresh install)
//   2. ~/.walkie/config.json          (the operator's own file — the self-host source of truth)
//   3. WALKIE_* environment variables  (CI/testing/dev overrides — never required at runtime)
//
// Paul's own instance keeps working: he runs `install-service.sh --init` once, his answers land
// in HIS ~/.walkie/config.json, and everything reads from there like any other operator.
//
// Nothing here throws just for loading. Individual getters throw ONLY when a value they need is
// truly absent (e.g. no workspace key for the live broker) — with a message that points the user
// at ~/.walkie/config.json, not at internals.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Expand a leading ~ to the user's home. Config files are hand-edited, so "~/walkie-sandbox"
// must Just Work. Absolute paths and relative paths pass through untouched.
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// Where the config lives. WALKIE_CONFIG_PATH lets a test point at a temp file.
export function configPath() {
  return process.env.WALKIE_CONFIG_PATH || join(homedir(), '.walkie', 'config.json');
}

// Baked defaults — deliberately NOT Paul-specific. A fresh install with only a workspace key
// and a sandbox repo set is a complete, working instance.
function defaults() {
  return {
    // Transport for the phone on-ramp:
    //   'local'       — the self-host WS+REST LocalBus on THIS Mac (default). No hosted Relaycast,
    //                   no rk_live_ workspace key, no ~/.secrets. This is the shipped self-host path.
    //   'agent-relay' — the original proven path: the SDK-backed conductor attached to a hosted
    //                   Agent Relay workspace (needs workspaceKey rk_live_…). Flip here to fall back.
    transport: 'local',
    workspaceKey: null,                 // rk_live_… — required ONLY for the agent-relay transport
    brokerApiKey: 'br_walkie',          // br_… the phone presents to the local broker
    brokerBind: '0.0.0.0',              // 0.0.0.0 so a real device reaches it over Tailscale
    brokerPort: '3889',
    brokerStateDir: join(homedir(), '.walkie', 'relay'),
    sandboxDir: join(homedir(), 'walkie-scratch'),  // the wizard auto-creates a local git repo here; builds land as branches
    sandboxRepo: null,                  // OPTIONAL "owner/repo" — set it to open PRs on your own repo; null = local scratch only
    galleryDir: join(homedir(), 'walkie-demos'),
    // OPTIONAL public hosts for shipped web demos. Default null = local-only: builds still stage
    // into galleryDir, but the EM reports the local path, not a live URL. Set these only if YOU
    // run a public server for the gallery. Nothing here may hardcode one person's domain.
    demoHost: null,                     // e.g. "demos.example.com" → https://demos.example.com/<slug>/
    galleryHost: null,                  // e.g. "gallery.example.com" → the gallery wall URL
    // Anonymous usage COUNTS (install done / service start / build done) to the Walkie team.
    // Baked default FALSE — this is the operator's machine. The installer writes true WITH a
    // spoken disclosure; flip to false here (or WALKIE_TELEMETRY=0) to stop. Never content:
    // see telemetry.mjs rule #1.
    telemetry: false,
    factoryRoot: null,                  // optional: a monorepo/portfolio root for Mara's "eyes"; null = no factory
    stateDir: join(homedir(), '.walkie'),
    directorName: 'Director',           // replaces the old hardcoded "Paul"
    anthropicModel: 'claude-sonnet-4-6',
    anthropicApiKey: null,              // BYOK for the EM (talkers). Builders use the keychain login, not this.
    // The sandbox-exec jail around builders. SELF-HOST DEFAULT: OFF.
    //   Why off: the jail (deliberately) blocks the builder from the login keychain, so a jailed
    //   builder can't use the operator's free Claude subscription → builds fail "Not logged in".
    //   On the operator's OWN Mac running their OWN agent, confining it is optional — the same trust
    //   they already extend every time they run Claude Code by hand. So builds work on first try.
    //   Turning it ON is a HARDENED OPT-IN and requires a bring-your-own metered API key
    //   (anthropicApiKey), since the subscription login is unreachable from inside the jail.
    //   This single field is the source of truth; nothing else (no plist env) overrides it.
    jailProfile: false,
  };
}

// Read + parse ~/.walkie/config.json if present. Missing file is NOT an error at load time —
// the demo path and CI (with env overrides) run without a config file.
function readConfigFile() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    throw new Error(`~/.walkie/config.json is not valid JSON (${err.message}). Fix it or re-run: bash scripts/install-service.sh --init`);
  }
}

// Environment overrides. Every field is overridable for CI/testing; the file is the norm for
// self-host. Only set a key if the env var is actually present (so we don't clobber file values
// with undefined).
function envOverrides() {
  const o = {};
  const map = {
    WALKIE_TRANSPORT: 'transport',
    WALKIE_RELAY_WORKSPACE_KEY: 'workspaceKey',
    WALKIE_BROKER_API_KEY: 'brokerApiKey',
    WALKIE_BROKER_BIND: 'brokerBind',
    WALKIE_BROKER_PORT: 'brokerPort',
    WALKIE_BROKER_STATE_DIR: 'brokerStateDir',
    WALKIE_SANDBOX_DIR: 'sandboxDir',
    WALKIE_SANDBOX_REPO: 'sandboxRepo',
    WALKIE_GALLERY_DIR: 'galleryDir',
    WALKIE_DEMO_HOST: 'demoHost',
    WALKIE_GALLERY_HOST: 'galleryHost',
    WALKIE_FACTORY_ROOT: 'factoryRoot',
    WALKIE_STATE_DIR: 'stateDir',
    WALKIE_DIRECTOR_NAME: 'directorName',
    WALKIE_ANTHROPIC_MODEL: 'anthropicModel',
    WALKIE_ANTHROPIC_API_KEY: 'anthropicApiKey',
  };
  for (const [envVar, key] of Object.entries(map)) {
    if (process.env[envVar] != null && process.env[envVar] !== '') o[key] = process.env[envVar];
  }
  if (process.env.WALKIE_JAIL_PROFILE != null) o.jailProfile = process.env.WALKIE_JAIL_PROFILE !== '0';
  if (process.env.WALKIE_TELEMETRY != null) o.telemetry = process.env.WALKIE_TELEMETRY !== '0';
  return o;
}

// Path-shaped fields that should have ~ expanded after merge.
const PATH_FIELDS = ['brokerStateDir', 'sandboxDir', 'galleryDir', 'factoryRoot', 'stateDir'];

let _cached = null;

// Load + merge the layered config. Cached so repeated getters don't re-read the file; pass
// { fresh: true } (tests) to bypass the cache.
export function loadConfig({ fresh = false } = {}) {
  if (_cached && !fresh) return _cached;
  const merged = { ...defaults(), ...readConfigFile(), ...envOverrides() };
  for (const f of PATH_FIELDS) if (merged[f]) merged[f] = expandHome(merged[f]);
  _cached = merged;
  return merged;
}

// For tests that mutate env between calls.
export function clearConfigCache() { _cached = null; }

// ── Guarded getters: throw only when a truly-required value is missing, with a helpful pointer.
// Used by the live broker/conductor. The demo path and unit tests avoid these (they read the
// plain fields off loadConfig()).

const HELP = `Set it in ~/.walkie/config.json, or run: bash scripts/install-service.sh --init`;

export function requireWorkspaceKey(cfg = loadConfig()) {
  const k = cfg.workspaceKey;
  if (!k || !String(k).startsWith('rk_live_')) {
    throw new Error(`no workspaceKey (rk_live_…). ${HELP}`);
  }
  return k;
}

export function requireSandboxRepo(cfg = loadConfig()) {
  const r = cfg.sandboxRepo;
  if (!r || !/^[^/\s]+\/[^/\s]+$/.test(String(r))) {
    throw new Error(`no sandboxRepo ("owner/repo"). This is YOUR practice repo — the builders open PRs here. ${HELP}`);
  }
  return r;
}

export function requireAnthropicApiKey(cfg = loadConfig()) {
  const k = cfg.anthropicApiKey;
  if (!k || !String(k).startsWith('sk-ant-')) {
    throw new Error(`no anthropicApiKey (sk-ant-…) for the EM. This is a metered API key, not a login. ${HELP}`);
  }
  return k;
}

// A non-throwing validation summary for the installer's --check and the service preflight.
// Returns { ok, problems: [ {key, message} ], cfg }.
export function validateConfig(cfg = loadConfig({ fresh: true })) {
  const problems = [];
  // The workspaceKey (rk_live_…) is ONLY required for the agent-relay transport. The default
  // 'local' transport runs a self-contained WS+REST bus with no hosted relay dependency, so a
  // fresh self-host install needs no rk_live_ key at all.
  if (cfg.transport === 'agent-relay' && (!cfg.workspaceKey || !String(cfg.workspaceKey).startsWith('rk_live_'))) {
    problems.push({ key: 'workspaceKey', message: 'missing or not an rk_live_ key (required for WALKIE_TRANSPORT=agent-relay)' });
  }
  // A place to build is required — but a GitHub repo is NOT. On the local transport the installer
  // auto-creates a local scratch repo (~/walkie-scratch), so the team has somewhere to work from
  // the first walk. sandboxRepo ("owner/repo") is OPTIONAL: set it later in Settings to turn on
  // the "open a PR on my real repo" path. If it IS set, it must be well-formed.
  if (!cfg.sandboxDir || !String(cfg.sandboxDir).trim()) {
    problems.push({ key: 'sandboxDir', message: 'missing — the wizard creates ~/walkie-scratch for you; re-run --init' });
  }
  if (cfg.sandboxRepo && !/^[^/\s]+\/[^/\s]+$/.test(String(cfg.sandboxRepo))) {
    problems.push({ key: 'sandboxRepo', message: 'set but not "owner/repo"' });
  }
  // anthropicApiKey is only required if there's no keychain login — the installer checks that
  // separately. Here we just note if it's set but malformed.
  if (cfg.anthropicApiKey && !String(cfg.anthropicApiKey).startsWith('sk-ant-')) {
    problems.push({ key: 'anthropicApiKey', message: 'set but does not start with sk-ant-' });
  }
  return { ok: problems.length === 0, problems, cfg };
}
