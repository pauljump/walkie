// The transport SEAM. Walkie's phone on-ramp has two interchangeable backends:
//
//   • LocalBus     (default, WALKIE_TRANSPORT=local)   — a pure-local WS+REST server on THIS Mac.
//                   No hosted Relaycast, no rk_live_ key, no ~/.secrets. The self-host default.
//   • AgentRelayBus (WALKIE_TRANSPORT=agent-relay)      — the ORIGINAL, proven path: the SDK-backed
//                   Conductor attached to a hosted Agent Relay workspace (needs an rk_live_ key).
//
// Both present the SAME small interface the rest of the conductor already speaks, so run-live.mjs,
// room.mjs, mara.mjs, and board.mjs are transport-agnostic:
//
//   await bus.start()                       — bring the transport up
//   bus.say(text, { channel, as })          — publish a line ("as" = a speaker handle for #work)
//   bus.registerSpeaker(name) -> handle     — mint a named voice for #work (Theo/Cora/Nia)
//   bus.watch({ directiveFrom, onDirective })— fire onDirective(text, from) for Director utterances
//   bus.feed / bus.surfaced / bus.transcript — the same observability arrays the Conductor exposes
//   bus.emName                              — the EM's name (so callers can read it if needed)
//   await bus.stop()                        — tear the transport down (tests)
//
// Selection is config-driven (cfg.transport). The AgentRelay path is kept fully intact and
// importable — flipping WALKIE_TRANSPORT=agent-relay returns to the exact proven behavior.

import { LocalBus } from './local-bus.mjs';
import { spawnClaudeWorker } from './spawn-claude.mjs';
import { loadConfig, validateConfig } from './config.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: conductor.mjs is imported LAZILY (dynamic import in makeBus) only for the agent-relay
// path, because it pulls in @agent-relay/sdk + @agent-relay/harnesses. The self-host LocalBus
// path must load with NO relay dependency present, so we never import it eagerly here.

const nameOf = (f) => (typeof f === 'string' ? f : (f?.name ?? f?.handle ?? f?.id ?? ''));

// ── LocalBus-backed conductor surface ───────────────────────────────────────────────────────
//
// A thin conductor over LocalBus. It owns the EM ("Mara") + engineer identities purely as NAMES
// (LocalBus preserves `from` verbatim, so a "speaker" is just its name — no registration handshake
// needed). say()/watch() are byte-identical in intent to Conductor's, but publish over the local
// server instead of the SDK. The build spawner (spawn-claude.mjs) is wired separately in
// conductor.mjs; the bus only carries the voice/#standup/#work channels and Director directives.
class LocalConductor {
  constructor({ emName = 'Mara', directorName = 'Director', bus, log = () => {}, build = {} }) {
    this.emName = emName;
    this.directorName = directorName;
    this.bus = bus;
    this.log = log;
    this.feed = [];        // every observed message
    this.surfaced = [];    // curated signal to the Director (bookkeeping parity with Conductor)
    this.transcript = [];  // every line WE published
    this.listeners = [];   // watch() fan-out
    // Builder settings for the DIRECT spawner (replaces the harness on the local path).
    this.build = {
      jail: build.jail !== false,          // default jailed on (self-host)
      stateDir: build.stateDir,
      realClaude: build.realClaude,        // tests point this at a fake claude
      binClaude: build.binClaude,          // absolute path to the shim (else spawner resolves it)
    };
  }

  async start() {
    await this.bus.start();
    // Observe every published message (REST posts from the phone + our own publishes). This is the
    // inbound side: the phone's Director directives arrive here and drive watch().
    this.bus.on('message', ({ from, text, channel }) => {
      if (!text) return;
      const ch = (channel || 'standup');
      this.feed.push({ from, text, channel: ch });
      this.log(`  [#${ch}] ${from}: ${text.slice(0, 120)}`);
      for (const fn of this.listeners) { try { fn({ from, text, channel: ch }); } catch {} }
    });
    this.log(`EM "${this.emName}" online (LocalBus transport)`);
    return this;
  }

  // A speaker over LocalBus is just its name — publishing preserves `from`, so no registration.
  registerSpeaker(name) { return { name }; }

  // Publish a line. Defaults to Mara on #standup (her voice to the Director). `as` (a speaker
  // handle from registerSpeaker) lets an engineer talk on #work under their own name.
  async say(text, { channel = 'standup', as } = {}) {
    const from = nameOf(as?.name) || this.emName;
    this.bus.publish({ from, text, channel });
    this.transcript.push({ channel, from, text });
    this.log(`${from} → #${channel}: ${text.slice(0, 120)}`);
  }

  // Watch #standup for Director directives (same semantics as Conductor.watch): a message on the
  // voice line, not our own echo, whose `from` contains the directive name.
  watch({ directiveFrom = 'Director', onDirective }) {
    const isDirective = (from) => nameOf(from).toLowerCase().includes(directiveFrom.toLowerCase());
    const handler = ({ from, text, channel }) => {
      if (channel && channel !== 'standup') return;
      if (nameOf(from).toLowerCase() === this.emName.toLowerCase()) return;
      if (!isDirective(from)) return;
      this.log(`EM hears Director: ${text.slice(0, 120)}`);
      Promise.resolve(onDirective(text, from)).catch((err) => this.log(`onDirective error: ${err.message}`));
    };
    this.listeners.push(handler);
    this.log(`EM watching #standup for directives from "${directiveFrom}"…`);
    return () => { this.listeners = this.listeners.filter((f) => f !== handler); };
  }

  // dispatch — the local path's builder. Same external contract as Conductor.dispatch (room.mjs
  // reads result.text), but backed by the DIRECT one-shot spawner instead of the relay harness:
  //   • claude (default): spawn the jailed one-shot; stdout is the bus; the DONE line is the report.
  //     Raw output is tee'd onto #build via onLine so the Team Room feed still works. The worker
  //     self-exits — no lingering PTY, no #releaseWorker pkill.
  //   • codex: not yet ported to the direct spawner. Available only on the agent-relay transport.
  async dispatch({ name, engine = 'claude', model, directive, verify, channel = 'build', cwd, task, timeoutMs = 600000 }) {
    if (engine === 'codex') {
      throw new Error(
        'codex builder is only available on WALKIE_TRANSPORT=agent-relay (not yet ported to the ' +
        'direct spawner). Use engine:"claude" on the local transport.',
      );
    }
    if (engine !== 'claude') throw new Error(`unknown engine: ${engine}`);
    this.log(`EM dispatches ${name} (direct claude spawn) → #${channel}…`);

    const result = await spawnClaudeWorker({
      name,
      task: task ?? directive,
      cwd,
      model,
      jail: this.build.jail,
      stateDir: this.build.stateDir,
      realClaude: this.build.realClaude,
      binClaude: this.build.binClaude,
      timeoutMs,
      // Tee raw build output onto the hidden #build channel so the iOS Team Room feed keeps
      // showing claude builders (the relay path did this by the worker joining #build).
      onLine: (line) => { try { this.bus.publish({ from: name, text: line, channel }); } catch {} },
      log: this.log,
    });

    const report = result.text;
    const verified = verify ? await Promise.resolve(verify()).catch(() => false) : true;
    const surfaced = verified
      ? { kind: 'review', from: name, engine, verified: true, text: report ?? 'done' }
      : { kind: 'blocked', from: name, engine, verified: false, text: report ?? 'no report; verification failed' };
    this.surfaced.push(surfaced);
    this.log(`EM surfaces → [${surfaced.kind}] ${name}: ${surfaced.text.slice(0, 120)} (verified=${verified})`);
    return surfaced;
  }

  async stop() { await this.bus.stop?.(); }
}

// ── Factory ──────────────────────────────────────────────────────────────────────────────────
//
// makeBus(cfg, { workspaceKey, log }) -> a conductor-shaped object. `workspaceKey` is only used by
// the agent-relay path (LocalBus ignores it — that's the point: self-host needs no rk_live_ key).
export async function makeBus(cfg, { workspaceKey, log = () => {}, cwd, build = {} } = {}) {
  const transport = cfg.transport || 'local';
  if (transport === 'agent-relay') {
    log('transport: agent-relay (hosted Relaycast workspace — the original proven path)');
    // The existing Conductor IS the agent-relay bus: same say/watch/registerSpeaker/feed surface.
    // Loaded lazily so the local path never needs @agent-relay/* installed.
    const { Conductor } = await import('./conductor.mjs');
    return new Conductor({ workspaceKey, emName: 'Mara', cwd, log });
  }
  if (transport !== 'local') log(`transport: unknown "${transport}", falling back to local`);
  log('transport: local (self-host WS+REST bus on this Mac — no hosted relay, no rk_live_ key)');
  // Readiness for GET /api/status. Recomputed LIVE per request (loadConfig fresh) so it reflects a
  // config edited after boot — a voice key added in Settings, or the sandbox git dir appearing once
  // the installer runs. cfg is in scope HERE, so the closure keeps LocalBus config-free (a pure
  // relay). Two axes carry human-readable "needs" the app can show; the app decides what to render.
  //   maraReady    == an sk-ant- Anthropic API key is set (the EM/"Mara" voice, metered). NOTE this
  //                   is NOT the builder auth — builders use the keychain Claude login, a different
  //                   readiness axis the installer checks, not surfaced here.
  //   sandboxReady == a git repo exists at sandboxDir (the practice project the installer creates).
  // This is scoped to the local self-host path; agent-relay readiness (Conductor) is out of scope.
  function readiness() {
    const v = validateConfig(loadConfig({ fresh: true }));
    const c = v.cfg;
    const maraReady = !!c.anthropicApiKey && String(c.anthropicApiKey).startsWith('sk-ant-');
    const sandboxReady = !!c.sandboxDir && existsSync(join(c.sandboxDir, '.git'));
    const needs = [];
    if (!maraReady) needs.push('Add your Anthropic API key (sk-ant-…) so the EM can talk. Open Settings, or re-run the installer.');
    if (!sandboxReady) needs.push('No practice project yet. Re-run the installer to create ~/walkie-scratch.');
    // Fold in the rest of validateConfig's problems, but SKIP the two we already spoke to in plain
    // copy above (missing anthropic key, missing sandboxDir) so a need is never listed twice.
    for (const p of v.problems) {
      if (p.key === 'sandboxDir') continue;                       // already covered by sandboxReady copy
      if (p.key === 'anthropicApiKey' && !maraReady) continue;    // already covered by maraReady copy
      needs.push(`${p.key}: ${p.message}`);
    }
    return { transport: c.transport || 'local', busUp: true, maraReady, sandboxReady, ready: maraReady && sandboxReady, needs };
  }
  const bus = new LocalBus({
    bind: cfg.brokerBind,
    port: cfg.brokerPort,
    apiKey: cfg.brokerApiKey,
    channels: ['standup', 'work'],
    log,
    readiness,
  });
  return new LocalConductor({
    emName: 'Mara',
    directorName: cfg.directorName,
    bus,
    log,
    build: {
      jail: build.jail !== undefined ? build.jail : cfg.jailProfile === true,  // single source: on only when explicitly true
      stateDir: build.stateDir ?? cfg.stateDir,
      realClaude: build.realClaude,
      binClaude: build.binClaude,
    },
  });
}
