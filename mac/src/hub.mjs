// The hub is the one place live sessions live. Every adapter (Claude Code, Codex, Antigravity, Grok) translates its
// CLI's native protocol into the same small event vocabulary, push it here, and the server fans it
// out to the phone. The CLIs' own session stores stay the durable history; the hub only holds what
// is live right now.
//
// Event vocabulary (the phone's contract). Every event carries an `id`; pushing an event whose id
// is already in the log replaces it in place, so a tool call can go running → ok without the phone
// tracking state machines.
//   user      { text }
//   text      { text }                       final assistant text
//   thinking  { text }
//   tool      { tool, title, detail?, diff?, output?, status: running|ok|error }
//   ask       { type: permission|question, title, detail?, diff?, options?, questions? }
//   resolved  { choice }                     id = the ask it closes
//   result    { ok, text?, costUsd?, durationMs? }
//   info      { text, link? }                link = a session key ("Continued in Codex")
//   error     { text }
// Every push stamps `seq`, a per-session counter that also moves when an event is replaced, so the
// phone can ask for "everything after seq N" when it reconnects. `epoch` changes whenever the hub
// rebuilds a session (bridge restart, reopen), telling the phone its seq is from an old log.
// A user event pushed while `session.nextClientId` is set carries that id, so the phone can match it
// to the message it queued.
// Streaming text is not logged: it lives in `session.draft` and travels as `draft` frames until the
// final `text` event supersedes it.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const LOG_CAP = 3000;

export class Session {
  constructor(hub, { agent, id, cwd, title = '' }) {
    this.hub = hub;
    this.agent = agent;
    this.id = id;
    this.cwd = cwd;
    this.title = title;
    this.status = 'idle'; // idle | running | waiting
    this.events = [];
    this.draft = '';
    this.pending = new Map(); // ask id → { resolve, event }
    this.updatedAt = Date.now();
    this.seq = 0;
    this.epoch = randomUUID().slice(0, 8);
    this.nextClientId = null; // { id, at }
  }

  // Events newer than `since`, or null when the caller's seq belongs to another epoch.
  since(seq, epoch) {
    if (epoch !== this.epoch || !(seq >= 0) || seq > this.seq) return null;
    return this.events.filter((e) => e.seq > seq);
  }

  get key() { return `${this.agent}:${this.id}`; }

  summary() {
    return {
      key: this.key, agent: this.agent, id: this.id, cwd: this.cwd, title: this.title,
      status: this.status, live: true, updatedAt: this.updatedAt, seq: this.seq, epoch: this.epoch, pending: this.pending.size, model: this.model || null, effort: this.effort || null,
    };
  }

  push(event) {
    const ev = { id: event.id || randomUUID(), ts: Date.now(), ...event, seq: ++this.seq };
    if (ev.kind === 'user' && this.nextClientId && !ev.clientId) {
      if (Date.now() - this.nextClientId.at < 120_000) ev.clientId = this.nextClientId.id;
      this.nextClientId = null;
    }
    if (ev.kind === 'text') this.draft = '';
    const at = this.events.findIndex((e) => e.id === ev.id);
    if (at >= 0) this.events[at] = ev;
    else {
      this.events.push(ev);
      if (this.events.length > LOG_CAP) this.events.splice(0, this.events.length - LOG_CAP);
    }
    if (!this.title && ev.kind === 'user') this.title = ev.text.slice(0, 80);
    this.updatedAt = ev.ts;
    this.hub.emit('frame', { type: 'event', key: this.key, event: ev });
    return ev;
  }

  appendDraft(delta) {
    this.draft += delta;
    this.hub.emit('frame', { type: 'draft', key: this.key, text: this.draft });
  }

  setStatus(status) {
    if (this.pending.size && status === 'running') status = 'waiting';
    if (this.status === status) return;
    this.status = status;
    this.updatedAt = Date.now();
    this.hub.emit('frame', { type: 'status', key: this.key, status, session: this.summary() });
  }

  // Ask the phone something and wait. Resolves with the reply object the phone sent, or
  // { cancelled: true } if the agent side aborted the request first.
  ask(spec, signal) {
    const event = this.push({ kind: 'ask', ...spec });
    return new Promise((resolve) => {
      const done = (reply, choice) => {
        if (!this.pending.delete(event.id)) return;
        this.push({ kind: 'resolved', id: `${event.id}:r`, ask: event.id, choice });
        this.setStatus(this.pending.size ? 'waiting' : 'running');
        resolve(reply);
      };
      this.pending.set(event.id, { event, done });
      this.setStatus('waiting');
      this.hub.emit('attention', { session: this, event });
      signal?.addEventListener('abort', () => done({ cancelled: true }, 'cancelled'), { once: true });
    });
  }

  answer(askId, reply) {
    const entry = this.pending.get(askId);
    if (!entry) return false;
    entry.done(reply, reply.choice || (reply.answers ? 'answered' : 'replied'));
    return true;
  }

  cancelPending() {
    for (const { done } of [...this.pending.values()]) done({ cancelled: true }, 'cancelled');
  }
}

export class Hub extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  open(spec) {
    const key = `${spec.agent}:${spec.id}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new Session(this, spec);
      this.sessions.set(key, s);
      this.emit('frame', { type: 'session', session: s.summary() });
    }
    return s;
  }

  get(key) { return this.sessions.get(key); }

  close(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    s.cancelPending();
    this.sessions.delete(key);
    this.emit('frame', { type: 'closed', key });
  }
}
