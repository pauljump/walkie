// Claude Code adapter. Runs the Mac's own `claude` binary through the Agent SDK's streaming-input
// mode, so a phone session is the same Claude Code as the desk: same login, settings, CLAUDE.md,
// skills, hooks and MCP servers, and it resumes the same session files the terminal writes.
// Permission prompts come back through canUseTool and become `ask` events on the phone.

import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { describeClaudeTool, resultText, clip } from './describe.mjs';

const IDLE_CLOSE_MS = 30 * 60 * 1000;
const ARCHIVED_TAG = 'archived';

const SESSIONS_DIR = () => join(process.env.HOME || '', '.claude', 'sessions');

// Which Claude sessions are running on this Mac, wherever they started (terminal, desktop, Remote
// Control, us). The truth is `claude agents --json`, Claude Code's own scripting interface for this.
// Remote Control state isn't in that output, so it's read from ~/.claude/sessions/<pid>.json, which is
// undocumented: a hint only, skipped when unreadable, never written.
export function registryHints(dir = SESSIONS_DIR()) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      if (typeof r.sessionId === 'string') out.set(r.sessionId, { remote: !!r.bridgeSessionId });
    } catch {}
  }
  return out;
}

export function makeRunningClaude({ claudePath = findClaude(), exec = execFileP, hints = registryHints, log = () => {} } = {}) {
  let cache = null; // { at, map }
  return {
    async get({ fresh = false } = {}) {
      if (!fresh && cache && Date.now() - cache.at < 2000) return cache.map;
      const map = new Map();
      try {
        const rows = JSON.parse(await exec(claudePath || 'claude', ['agents', '--json']));
        const h = hints();
        for (const r of rows) if (typeof r.sessionId === 'string') map.set(r.sessionId, { status: r.status || null, remote: !!h.get(r.sessionId)?.remote });
      } catch (e) {
        log(`[claude agents] ${e.message}`);
        if (cache) return cache.map; // keep the last good answer rather than calling everything stopped
      }
      cache = { at: Date.now(), map };
      return map;
    },
    // Claude adds and removes a file in ~/.claude/sessions as sessions start and stop; that's our cue to
    // ask again. The server also re-asks on a slow timer for anything that dies without cleaning up.
    watch(onChange, dir = SESSIONS_DIR()) {
      let t = null;
      try {
        const w = watch(dir, () => { clearTimeout(t); t = setTimeout(() => { cache = null; onChange(); }, 300); });
        return () => { clearTimeout(t); w.close(); };
      } catch { return () => {}; }
    },
  };
}

class Inbox {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false }); else this.items.push(item);
  }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10_000, maxBuffer: 4 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));
}

export function findClaude() {
  try { return execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

// One message (live SDK message or a transcript entry) → events. Shared by live streaming and
// history replay so both render identically.
export function claudeMessageEvents(msg, { toolNames = new Map() } = {}) {
  const out = [];
  const m = msg.message;
  if (!m) return out;
  if (msg.parent_tool_use_id) return out; // subagent chatter stays inside its Agent tool card
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
  if (msg.type === 'assistant') {
    content.forEach((b, i) => {
      const base = `${m.id || msg.uuid}:${i}`;
      if (b.type === 'text' && b.text?.trim()) out.push({ id: base, kind: 'text', text: b.text });
      else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ id: base, kind: 'thinking', text: clip(b.thinking, 6000) });
      else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        out.push({ id: b.id, kind: 'tool', tool: b.name, status: 'running', ...describeClaudeTool(b.name, b.input) });
      }
    });
  } else if (msg.type === 'user') {
    for (const b of content) {
      if (b.type === 'tool_result') {
        out.push({ id: b.tool_use_id, kind: 'tool', patch: true, status: b.is_error ? 'error' : 'ok', output: resultText(b.content) });
      } else if (b.type === 'text' && !msg.isSynthetic && !isInternal(b.text)) {
        out.push({ id: msg.uuid || randomUUID(), kind: 'user', text: b.text });
      }
    }
  }
  return out;
}

const isInternal = (t = '') => /^\s*<(command-|local-command|system-reminder|bash-|task-notification)/.test(t) || t.startsWith('Caveat: The messages below');

// A tool result only carries status/output; merge it into the tool card already in the log.
function pushAll(session, events) {
  for (const ev of events) {
    if (ev.patch) {
      const prior = session.events.find((e) => e.id === ev.id);
      const { patch, ...rest } = ev;
      const { ts, ...base } = prior || { title: 'Tool result', tool: 'tool' };
      session.push({ ...base, ...rest });
    } else session.push(ev);
  }
}

export function makeClaude({ hub, query = sdk.query, listSessions = sdk.listSessions, getSessionMessages = sdk.getSessionMessages, renameSession = sdk.renameSession, tagSession = sdk.tagSession, running = null, log = () => {} }) {
  const live = new Map(); // session key → runner
  const claudePath = findClaude();
  running ||= makeRunningClaude({ claudePath, log });

  function runner(session, { resume, model, mode, effort }) {
    const inbox = new Inbox();
    const permissionMode = mode === 'auto' ? 'acceptEdits' : mode === 'plan' ? 'plan' : undefined;
    const q = query({
      prompt: inbox,
      options: {
        cwd: session.cwd,
        ...(resume ? { resume: session.id } : { sessionId: session.id }),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'walkie/3.0.0' },
        canUseTool: (name, input, opts) => canUseTool(session, name, input, opts),
        stderr: (line) => log(`[claude ${session.id.slice(0, 8)}] ${line.trimEnd()}`),
      },
    });
    const r = { q, inbox, idle: null, commands: null, fresh: !resume, titled: false };
    pump(session, r).catch((err) => {
      session.push({ kind: 'error', text: `Claude Code stopped: ${err.message}` });
    }).finally(() => {
      session.cancelPending();
      session.setStatus('idle');
      live.delete(session.key);
    });
    return r;
  }

  async function pump(session, r) {
    const toolNames = new Map();
    for await (const msg of r.q) {
      if (msg.type === 'stream_event') {
        const e = msg.event;
        if (!msg.parent_tool_use_id && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') session.appendDraft(e.delta.text);
        continue;
      }
      if (msg.type === 'rate_limit_event') { hub.emit('rate-limit', msg.rate_limit_info); continue; }
      if (msg.type === 'system' && msg.subtype === 'init') {
        r.commands = msg.slash_commands || null;
        r.model = msg.model;
        if (!session.model || session.model === 'default') session.model = msg.model;
        continue;
      }
      if (msg.type === 'result') {
        session.push({
          kind: 'result', ok: msg.subtype === 'success' && !msg.is_error,
          text: msg.subtype === 'success' ? undefined : (msg.errors || []).join('\n') || msg.subtype,
          costUsd: msg.total_cost_usd, durationMs: msg.duration_ms,
        });
        session.setStatus('idle');
        armIdle(session, r);
        if (r.fresh && !r.titled) { r.titled = true; nameSession(session, r); }
        continue;
      }
      if (msg.type === 'user' && !msg.isReplay && msg.message?.role === 'user' && !hasToolResult(msg)) continue; // our own input, already shown
      pushAll(session, claudeMessageEvents(msg, { toolNames }));
    }
  }

  // Claude's terminal names a session after its first reply; SDK sessions don't, so they'd show their
  // last prompt ("Ok done"). Ask Claude for the same kind of title, saved in its own session file.
  function nameSession(session, r) {
    if (!r.q.generateSessionTitle) return;
    const said = (kind) => session.events.find((e) => e.kind === kind)?.text || '';
    const description = `${said('user')}\n\n${said('text')}`.slice(0, 1500).trim();
    if (!description) return;
    r.q.generateSessionTitle(description, { persist: true }).then((title) => {
      if (!title) return;
      session.title = String(title).slice(0, 120);
      hub.emit('frame', { type: 'session', session: session.summary() });
      hub.emit('frame', { type: 'sessions' });
    }, (e) => log(`[claude ${session.id.slice(0, 8)}] title: ${e.message}`));
  }

  const hasToolResult = (msg) => Array.isArray(msg.message?.content) && msg.message.content.some((b) => b.type === 'tool_result');

  function armIdle(session, r) {
    clearTimeout(r.idle);
    r.idle = setTimeout(() => { if (session.status === 'idle') r.inbox.close(); }, IDLE_CLOSE_MS);
    r.idle.unref?.();
  }

  async function canUseTool(session, name, input, { signal, suggestions } = {}) {
    if (name === 'AskUserQuestion') {
      const reply = await session.ask({ type: 'question', title: 'Claude has a question', questions: input.questions }, signal);
      if (reply.cancelled || !reply.answers) return { behavior: 'deny', message: reply.message || 'The user dismissed the question.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: reply.answers } };
    }
    const d = describeClaudeTool(name, input);
    const options = [{ id: 'allow', label: 'Allow' }];
    if (suggestions?.length) options.push({ id: 'always', label: 'Always allow' });
    options.push({ id: 'deny', label: 'Deny', style: 'destructive' });
    const reply = await session.ask({ type: 'permission', tool: name, title: d.title, detail: d.detail, diff: d.diff, options }, signal);
    if (reply.choice === 'allow') return { behavior: 'allow', updatedInput: input };
    if (reply.choice === 'always') return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
    return { behavior: 'deny', message: reply.message || 'Denied from Walkie.' };
  }

  function ensureLive(session, opts) {
    let r = live.get(session.key);
    if (!r) { r = runner(session, opts); live.set(session.key, r); }
    return r;
  }

  return {
    agent: 'claude',

    // Sync (docs/SYNC.md): titles and archive live in Claude's own session files, so a rename here
    // shows in the terminal's /resume and a rename there shows here.
    sync: { rename: 'native', archive: 'native', running: 'native' },

    async list({ cwd, limit = 40, archived = false } = {}) {
      const [rows, now] = await Promise.all([listSessions(cwd ? { dir: cwd, limit } : { limit }), running.get()]);
      return rows.filter((s) => (s.tag === ARCHIVED_TAG) === archived).map((s) => {
        const r = now.get(s.sessionId);
        return {
          agent: 'claude', id: s.sessionId, cwd: s.cwd || cwd, title: s.customTitle || s.summary || s.firstPrompt || '',
          updatedAt: s.lastModified, branch: s.gitBranch, running: !!r, remote: !!r?.remote, archived: s.tag === ARCHIVED_TAG,
        };
      });
    },

    // Running on this Mac but not by us (a terminal, the Claude app). Sending into it would resume a
    // second copy writing the same session file, so the server refuses until it's closed there.
    async runningElsewhere(id) { return !live.has(`claude:${id}`) && (await running.get({ fresh: true })).has(id); },

    async runningIds({ fresh = false } = {}) { return [...(await running.get({ fresh })).keys()]; },
    watchRunning(onChange) { return running.watch(onChange); },

    // A session Walkie is running gets the rename the way the Claude app sends one: to the process
    // itself, which records it and updates the name Remote Control and the terminal show. Anything
    // else gets Claude's own title line appended to its session file.
    async rename(id, title, { cwd } = {}) {
      const r = live.get(`claude:${id}`);
      let told = false;
      if (r?.q?.renameSession) {
        told = await Promise.race([
          r.q.renameSession(title).then(() => true, (e) => { log(`[claude ${id.slice(0, 8)}] live rename failed: ${e.message}`); return false; }),
          new Promise((ok) => { const t = setTimeout(() => ok(false), 5000); t.unref?.(); }),
        ]);
      }
      if (!told) await renameSession(id, title, cwd ? { dir: cwd } : {});
      const s = hub.get(`claude:${id}`);
      if (s) s.title = title;
    },

    async archive(id, on, { cwd } = {}) { await tagSession(id, on ? ARCHIVED_TAG : null, cwd ? { dir: cwd } : {}); },

    async history(id, { cwd } = {}) {
      const msgs = await getSessionMessages(id, cwd ? { dir: cwd } : {});
      const fake = { events: [], push(ev) { const i = this.events.findIndex((e) => e.id === ev.id); if (i >= 0) this.events[i] = ev; else this.events.push(ev); } };
      const toolNames = new Map();
      for (const m of msgs) pushAll(fake, claudeMessageEvents(m, { toolNames }));
      return fake.events;
    },

    // New session: we choose the UUID up front so the phone has a stable handle immediately.
    start({ cwd, text, model, mode, effort }) {
      const session = hub.open({ agent: 'claude', id: randomUUID(), cwd, title: text.slice(0, 80) });
      session.model = model || 'default';
      session.effort = effort || null;
      ensureLive(session, { resume: false, model, mode, effort });
      this.send(session, text);
      return session;
    },

    async send(session, text, { model, mode, effort } = {}) {
      const fresh = !live.has(session.key);
      const r = ensureLive(session, { resume: session.events.length > 0 || session.resumed, model, mode, effort: effort || session.effort });
      if (effort && !fresh && effort !== session.effort) await r.q.applyFlagSettings({ effortLevel: effort }).catch(() => {});
      if (effort) session.effort = effort;
      // Switching model mid-session: a live Claude Code process can change model between turns.
      if (model && !fresh && model !== session.model) await r.q.setModel(model).catch(() => {});
      if (model) session.model = model;
      clearTimeout(r.idle);
      session.push({ kind: 'user', text });
      session.setStatus('running');
      r.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } });
    },

    // Effort changes apply to a running session right away, between (or even during) turns.
    async setEffort(session, effort) {
      session.effort = effort;
      const r = live.get(session.key);
      if (r) await r.q.applyFlagSettings({ effortLevel: effort });
    },

    async interrupt(session) {
      const r = live.get(session.key);
      session.cancelPending();
      if (r) await r.q.interrupt().catch(() => {});
    },

    async commands(session) {
      const r = session && live.get(session.key);
      if (r?.q?.supportedCommands) return (await r.q.supportedCommands()).map((c) => ({ name: c.name, description: c.description }));
      return [];
    },

    close(session) {
      const r = live.get(session.key);
      if (r) r.inbox.close();
    },
  };
}
