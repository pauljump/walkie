import { AgentRelay } from '@agent-relay/sdk';
import { claude, codex } from '@agent-relay/harnesses';
import { spawn } from 'node:child_process';

// The EM conductor — the heart of Walkie. The Director hands it a directive; it
// dispatches the work to a real Agent Relay worker (Claude or Codex), holds the
// verification gate, and surfaces ONLY a verified, classified result. The agents
// coordinate in a channel the conductor observes; the conductor is the one-way
// valve to the Director (product law #1: only real signal, no chatter).

const nameOf = (f) => (typeof f === 'string' ? f : (f?.name ?? f?.handle ?? f?.id ?? ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINES = { claude, codex };

export class Conductor {
  // `workspaceKey` (rk_live_…) attaches the EM to an EXISTING workspace — the one the
  // phone's local broker also joins, so the Director (phone) and the EM share #standup.
  // Without it, a throwaway workspace is minted (the demo path).
  constructor({ workspace = 'walkie', workspaceKey, emName = 'Mara', cwd, log = () => {} } = {}) {
    this.workspaceName = workspace;
    this.workspaceKey = workspaceKey;
    this.emName = emName;
    this.cwd = cwd;
    this.log = log;
    this.feed = [];        // every channel message observed (the work channel)
    this.surfaced = [];    // only verified signal handed to the Director (the voice channel)
    this.transcript = [];  // every line WE posted (ground truth of what went to each channel)
    this.listeners = [];   // message.created subscribers (watch loop fan-out)
  }

  async start() {
    this.relay = this.workspaceKey
      ? new AgentRelay({ workspaceKey: this.workspaceKey })
      : await AgentRelay.createWorkspace(this.workspaceName);
    this.em = await this.relay.workspace.register({ name: this.emName });
    // Three channels: #standup = Mara↔Director (the voice line, the phone joins it),
    // #work = Mara↔engineers (the watchable team room), #build = raw harness output (hidden).
    for (const name of ['standup', 'work', 'build']) {
      await this.em.channels?.create?.({ name, topic: 'walkie' }).catch(() => {});
    }
    this.relay.addListener('message.created', (e) => {
      const m = e?.message ?? e;
      const from = nameOf(m?.from ?? m?.author ?? m?.agent ?? m?.sender);
      const text = (m?.text ?? m?.body ?? m?.content ?? '').toString();
      const channel = (nameOf(m?.channel ?? m?.target ?? m?.to ?? '') || 'standup').replace(/^#/, '') || 'standup';
      if (!text) return;
      this.feed.push({ from, text, channel });
      this.log(`  [#${channel}] ${from}: ${text.slice(0, 120)}`);
      for (const fn of this.listeners) { try { fn({ from, text, channel }); } catch {} }
    });
    this.log(`EM "${this.emName}" online${this.workspaceKey ? ' (attached to shared workspace)' : ` in workspace "${this.workspaceName}"`}`);
    return this;
  }

  // Register another voice in the workspace (an engineer persona) so it can post to #work
  // under its own name. Returns an agent handle to pass as `as` to say().
  registerSpeaker(name) {
    return this.relay.workspace.register({ name });
  }

  // Post a line to a channel. Defaults to Mara on #standup (her voice to the Director).
  // Pass { channel: 'work', as: speaker } to talk in the team room as an engineer.
  async say(text, { channel = 'standup', as } = {}) {
    const speaker = as ?? this.em;
    const from = nameOf(as?.name) || this.emName;
    await speaker.sendMessage({ to: `#${channel}`, text });
    this.transcript.push({ channel, from, text });
    this.log(`${from} → #${channel}: ${text.slice(0, 120)}`);
  }

  // Live loop: watch #standup for a Director directive and run a handler. A directive is a
  // message from `directiveFrom` (the broker instance name the phone posts under, e.g.
  // "Director") — never the EM's own echoes or a worker's reports. Returns a stop fn.
  watch({ directiveFrom = 'Director', onDirective }) {
    const isDirective = (from) => nameOf(from).toLowerCase().includes(directiveFrom.toLowerCase());
    const handler = ({ from, text, channel }) => {
      if (channel && channel !== 'standup') return;                         // directives only on the voice line
      if (nameOf(from).toLowerCase() === this.emName.toLowerCase()) return; // never our own echo
      if (!isDirective(from)) return;                                       // ignore worker reports
      this.log(`EM hears Director: ${text.slice(0, 120)}`);
      Promise.resolve(onDirective(text, from)).catch((err) => this.log(`onDirective error: ${err.message}`));
    };
    this.listeners.push(handler);
    this.log(`EM watching #standup for directives from "${directiveFrom}"…`);
    return () => { this.listeners = this.listeners.filter((f) => f !== handler); };
  }

  // Director directive -> worker -> verification gate -> surfaced result.
  // `verify` is the gate (e.g., tests pass / a diff exists). Returns the single
  // classified result the Director should hear.
  async dispatch({ name, engine = 'claude', model, directive, verify, channel = 'standup', cwd = this.cwd, task, timeoutMs = 150000 }) {
    const harness = ENGINES[engine];
    if (!harness) throw new Error(`unknown engine: ${engine}`);
    this.log(`EM dispatches ${name} (${engine}) → #${channel}…`);
    await harness.create({
      relay: this.relay,
      name,
      ...(model ? { model } : {}),
      cwd,
      channels: [channel],
      task: (task ?? directive) + `\n\nWhen finished, post ONE line to the #${channel} channel starting with "DONE:" that summarizes what you did. Do nothing else.`,
    });

    let report;
    try {
      report = await this.#waitForReport(name, timeoutMs);
    } finally {
      // Always release the worker — on success AND on timeout. Harness workers run as a
      // PTY (`agent-relay-broker pty --agent-name <name> claude …`) and do NOT self-exit
      // after they finish; left alone they linger as idle processes, pile up across builds,
      // and collide on the reused name. Releasing every time = no zombies, and a stuck build
      // is actually terminated at the timeout (not just abandoned). See issue #31.
      this.#releaseWorker(name);
    }
    const verified = verify ? await Promise.resolve(verify()).catch(() => false) : true;

    const surfaced = verified
      ? { kind: 'review', from: name, engine, verified: true, text: report ?? 'done' }
      : { kind: 'blocked', from: name, engine, verified: false, text: report ?? 'no report; verification failed' };
    this.surfaced.push(surfaced);
    this.log(`EM surfaces → [${surfaced.kind}] ${name}: ${surfaced.text.slice(0, 120)} (verified=${verified})`);
    return surfaced;
  }

  // Terminate a harness worker's PTY by name. Targeted + safe: only matches the worker
  // process (`agent-relay-broker pty --agent-name <name> …`); the long-lived broker runs
  // `agent-relay-broker init …`, so it can never be hit. Fire-and-forget; no match is fine.
  #releaseWorker(name) {
    try {
      const p = spawn('pkill', ['-f', `agent-relay-broker pty --agent-name ${name}`], { stdio: 'ignore' });
      p.on('error', () => {});
      this.log(`released worker ${name}`);
    } catch { /* best effort */ }
  }

  async #waitForReport(name, timeoutMs) {
    const start = Date.now();
    const mine = (m) => nameOf(m.from).toLowerCase().includes(name.toLowerCase());
    while (Date.now() - start < timeoutMs) {
      const done = this.feed.find((m) => mine(m) && m.text.includes('DONE'));
      if (done) return done.text;
      await sleep(1000);
    }
    return this.feed.find(mine)?.text ?? null; // fall back to any message from the worker
  }
}
