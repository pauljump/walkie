// Codex adapter. One long-lived `codex app-server` process (JSON-RPC over stdio) serves every Codex
// session, using the Mac's own Codex login and ~/.codex/config.toml. Threads are the same ones the
// terminal CLI writes, so desk sessions show up and resume on the phone. Approval and user-input
// requests from the server become `ask` events.

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { clip, codexDiff, shortPath } from './describe.mjs';

// Newline-delimited JSON from Codex, without ever holding one line bigger than `cap`. Node can't make a
// string past ~512 MB, and one 4.4 GB thread's history came back as a single line, which crashed the
// whole bridge. An oversized line is dropped; its request id (read from the first bytes) is reported so
// only that request fails.
export function readLines(stream, onLine, onOversize, cap = 64 * 1024 * 1024) {
  let parts = []; let size = 0; let head = ''; let dropping = false;
  const keepHead = (b) => { if (head.length < 200) head += b.subarray(0, 200 - head.length).toString(); };
  stream.on('data', (chunk) => {
    let start = 0; let i;
    while ((i = chunk.indexOf(10, start)) >= 0) {
      const piece = chunk.subarray(start, i);
      keepHead(piece); size += piece.length;
      if (dropping || size > cap) onOversize(Number(head.match(/"id"\s*:\s*(\d+)/)?.[1]), size);
      else onLine(Buffer.concat([...parts, piece]).toString('utf8'));
      parts = []; size = 0; head = ''; dropping = false; start = i + 1;
    }
    const rest = chunk.subarray(start);
    keepHead(rest); size += rest.length;
    if (size > cap) { dropping = true; parts = []; } else if (rest.length) parts.push(rest);
  });
}

const THREAD_ID = /^[0-9a-f-]{36}$/;

// A voice chat's transcript as Walkie events: what you said is a user message, Codex's replies are
// text, both marked `voice` so the phone can show they were spoken.
export function voiceEvents(rows = []) {
  const out = [];
  for (const r of rows) {
    let item; try { item = JSON.parse(r.item_json); } catch { continue; }
    const base = { id: r.item_id, ts: r.created_at_ms, voice: true };
    if (item.type === 'transcript_segment' && item.text?.trim()) out.push({ ...base, kind: item.role === 'user' ? 'user' : 'text', text: item.text.trim() });
    else if (item.type === 'realtime_session_started') out.push({ ...base, kind: 'info', text: 'Voice chat started' });
    else if (item.type === 'realtime_session_closed') out.push({ ...base, kind: 'info', text: 'Voice chat ended' });
  }
  return out;
}

// Codex errors in words you can act on. Running out of plan usage is the common one; say when it resets.
export function friendlyError(err = {}) {
  const message = err.message ?? (typeof err === 'string' ? err : 'Codex error');
  if (err.codexErrorInfo === 'usageLimitExceeded') {
    const when = message.match(/try again at ([^.]+?)\.?$/i)?.[1];
    return when ? `Codex usage limit reached. It resets ${when}.` : 'Codex usage limit reached.';
  }
  return message;
}

// Codex runs commands as `/bin/zsh -lc '<cmd>'`; show just <cmd>.
export function bareCommand(cmd) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
  const m = s.match(/^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

const ms = (t) => (t == null ? Date.now() : t < 1e12 ? t * 1000 : t);

// ThreadItem → event (or null). Shared by live notifications and history replay.
export function codexItemEvent(item, { done = true } = {}) {
  const status = !done ? 'running' : ['failed', 'declined', 'error'].includes(item.status) ? 'error' : 'ok';
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return text ? { id: item.id, kind: 'user', text } : null;
    }
    case 'agentMessage': return done && item.text?.trim() ? { id: item.id, kind: 'text', text: item.text } : null;
    case 'reasoning': {
      const text = [...(item.summary || []), ...(item.summary?.length ? [] : item.content || [])].join('\n').trim();
      return done && text ? { id: item.id, kind: 'thinking', text: clip(text, 6000) } : null;
    }
    case 'plan': return done && item.text ? { id: item.id, kind: 'info', text: item.text } : null;
    case 'commandExecution': return {
      id: item.id, kind: 'tool', tool: 'shell', title: `$ ${bareCommand(item.command)}`, status: item.exitCode && item.exitCode !== 0 ? 'error' : status,
      detail: item.cwd ? shortPath(item.cwd) : undefined, output: item.aggregatedOutput ? clip(item.aggregatedOutput) : undefined,
    };
    case 'fileChange': return {
      id: item.id, kind: 'tool', tool: 'edit', status,
      title: `Edit ${(item.changes || []).map((c) => shortPath(c.path).split('/').pop()).join(', ')}`,
      diff: codexDiff(item.changes),
    };
    case 'mcpToolCall': return {
      id: item.id, kind: 'tool', tool: 'mcp', title: `${item.server} · ${item.tool}`, status: item.error ? 'error' : status,
      detail: item.arguments ? clip(JSON.stringify(item.arguments), 1500) : undefined,
      output: item.error ? String(item.error.message ?? item.error) : item.result ? clip(JSON.stringify(item.result)) : undefined,
    };
    case 'dynamicToolCall': return { id: item.id, kind: 'tool', tool: item.tool, title: item.tool, status: item.success === false ? 'error' : status };
    case 'webSearch': return { id: item.id, kind: 'tool', tool: 'web', title: `Search web: ${item.query ?? ''}`, status };
    case 'collabAgentToolCall': return { id: item.id, kind: 'tool', tool: 'agent', title: `Agent: ${item.tool}`, detail: clip(item.prompt, 1500), status };
    case 'contextCompaction': return done ? { id: item.id, kind: 'info', text: 'Context compacted' } : null;
    default: return null;
  }
}

export function makeCodex({ hub, spawn = nodeSpawn, codexHome = join(process.env.HOME || '', '.codex'), voiceQuery = null, quickMs = 30_000, log = () => {} }) {
  let proc = null;
  const voice = voiceQuery || ((sql) => new Promise((resolve) => {
    execFile('sqlite3', ['-json', `file:${join(codexHome, 'thread_history_1.sqlite')}?immutable=1`, sql], { timeout: 10_000, maxBuffer: 32 << 20 }, (e, out) => {
      if (e) { if (!/no such table|unable to open/.test(String(e.message))) log(`[codex voice] ${String(e.message).split('\n')[0]}`); return resolve([]); }
      try { resolve(out.trim() ? JSON.parse(out) : []); } catch { resolve([]); }
    });
  }));
  let ready = null;
  let nextId = 1;
  const calls = new Map();      // rpc id → { resolve, reject }
  const threads = new Map();    // threadId → { session, turnId }
  const fileItems = new Map();  // itemId → fileChange item (for approval diffs)

  function boot() {
    if (ready) return ready;
    const child = proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    // Codex missing or unable to start: fail the calls waiting on it, and try again on the next call.
    child.on('error', (err) => { log(`[codex] couldn't start app-server: ${err.message}`); gone(child, err.code === 'ENOENT' ? 'Codex isn\'t installed on this Mac (no `codex` on PATH).' : `Codex couldn't start: ${err.message}`); });
    child.stdin.on('error', (err) => log(`[codex] stdin: ${err.message}`));
    readLines(proc.stdout, (line) => { if (line.trim()) { try { onMessage(JSON.parse(line)); } catch (err) { log(`[codex] bad line: ${err.message}`); } } }, (id, bytes) => {
      log(`[codex] dropped a ${(bytes / 1e6).toFixed(0)} MB response`);
      const c = calls.get(id);
      if (c) { calls.delete(id); clearTimeout(c.timer); c.reject(new Error('That Codex conversation is too large to open on the phone.')); }
    });
    child.stderr.on('data', (d) => log(`[codex] ${String(d).trimEnd()}`));
    child.on('exit', (code) => { log(`[codex] app-server exited (${code})`); gone(child, 'Codex stopped unexpectedly. Send again to restart it.'); });
    ready = rpc('initialize', { clientInfo: { name: 'walkie', title: 'Walkie', version: '3.0.0' } }, 30_000)
      .then((res) => { write({ method: 'initialized' }); return res; }, (err) => { ready = null; throw err; });
    return ready;
  }

  // The app-server is gone (exited or never started): everything waiting on it fails now, live turns end,
  // and the next call starts a fresh one.
  function gone(child, why) {
    if (proc !== child) return;
    for (const c of calls.values()) { clearTimeout(c.timer); c.reject(new Error(why)); }
    calls.clear();
    for (const { session } of threads.values()) {
      session.cancelPending();
      if (session.status !== 'idle') session.push({ kind: 'error', text: why });
      session.setStatus('idle');
    }
    threads.clear();
    proc = null; ready = null;
  }

  function write(msg) {
    if (!proc?.stdin?.writable) throw new Error('Codex isn\'t running.');
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  // `ms` bounds calls that should answer quickly (lists, reads); a turn's own call has no limit.
  function rpc(method, params, ms = 0) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = ms ? setTimeout(() => { if (calls.delete(id)) reject(new Error(`Codex didn't answer ${method} in ${ms / 1000}s`)); }, ms) : null;
      timer?.unref?.();
      calls.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); } catch (err) { calls.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  async function call(method, params, ms = quickMs) { await boot(); return rpc(method, params, ms); }

  function onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const c = calls.get(msg.id);
      if (!c) return;
      calls.delete(msg.id);
      clearTimeout(c.timer);
      if (msg.error) c.reject(new Error(msg.error.message || 'codex error')); else c.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) { onServerRequest(msg).catch((err) => { try { write({ id: msg.id, error: { code: -32603, message: err.message } }); } catch {} }); return; }
    if (msg.method) onNotification(msg.method, msg.params || {});
  }

  function sessionFor(threadId) { return threads.get(threadId)?.session; }

  function onNotification(method, p) {
    const t = threads.get(p.threadId);
    const s = t?.session;
    switch (method) {
      case 'turn/started': if (t) { t.turnId = p.turn?.id; s.setStatus('running'); } break;
      case 'turn/completed': if (t) {
        t.turnId = null;
        const err = p.turn?.error;
        // The same failure usually arrived a moment ago as an `error` event; don't show it twice.
        const said = err && s.events.findLast((e) => e.kind === 'error')?.text === friendlyError(err);
        s.push({ kind: 'result', ok: p.turn?.status === 'completed', text: err ? (said ? undefined : friendlyError(err)) : p.turn?.status !== 'completed' ? p.turn?.status : undefined, durationMs: p.turn?.durationMs ?? undefined });
        s.setStatus('idle');
      } break;
      case 'item/agentMessage/delta': s?.appendDraft(p.delta); break;
      case 'item/started':
      case 'item/completed': {
        if (!s) break;
        if (p.item?.type === 'fileChange') fileItems.set(p.item.id, p.item);
        const ev = codexItemEvent(p.item, { done: method === 'item/completed' });
        if (ev) s.push(ev);
        break;
      }
      case 'error': s?.push({ kind: 'error', text: friendlyError(p.error ?? p) }); break;
      case 'thread/name/updated': if (s && p.name) s.title = p.name; break;
      case 'account/rateLimits/updated': hub.emit('usage-changed', 'codex'); break;
      default: break;
    }
  }

  async function onServerRequest({ id, method, params: p }) {
    const s = sessionFor(p.threadId);
    if (!s) { write({ id, error: { code: -32000, message: 'No Walkie session for this thread' } }); return; }
    const choices = [
      { id: 'accept', label: 'Allow' },
      { id: 'acceptForSession', label: 'Allow for session' },
      { id: 'decline', label: 'Deny', style: 'destructive' },
    ];
    if (method === 'item/commandExecution/requestApproval') {
      const reply = await s.ask({ type: 'permission', tool: 'shell', title: `$ ${p.command ? bareCommand(p.command) : '(command)'}`, detail: p.reason ?? undefined, options: choices });
      write({ id, result: { decision: reply.cancelled ? 'cancel' : reply.choice || 'decline' } });
    } else if (method === 'item/fileChange/requestApproval') {
      const item = fileItems.get(p.itemId);
      const reply = await s.ask({ type: 'permission', tool: 'edit', title: item ? codexItemEvent(item).title : 'Apply file changes', detail: p.reason ?? undefined, diff: item ? codexDiff(item.changes) : undefined, options: choices });
      write({ id, result: { decision: reply.cancelled ? 'cancel' : reply.choice || 'decline' } });
    } else if (method === 'item/tool/requestUserInput') {
      const questions = (p.questions || []).map((q) => ({ id: q.id, header: q.header, question: q.question, options: (q.options || []).map((o) => ({ label: o.label, description: o.description ?? '' })), multiSelect: false }));
      const reply = await s.ask({ type: 'question', title: 'Codex has a question', questions });
      const answers = {};
      for (const q of questions) {
        const a = reply.answers?.[q.question] ?? reply.answers?.[q.id];
        answers[q.id] = { answers: a == null ? [] : Array.isArray(a) ? a : String(a).split(', ') };
      }
      write({ id, result: { answers } });
    } else {
      s.push({ kind: 'info', text: `Codex asked for "${method}", which Walkie can't answer yet — declined.` });
      write({ id, error: { code: -32601, message: `Walkie does not handle ${method}` } });
    }
  }

  function modeParams(mode) {
    if (mode === 'auto') return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    return {};
  }

  async function attach(session, { model, mode } = {}) {
    if (threads.has(session.id)) return;
    await call('thread/resume', { threadId: session.id, excludeTurns: true, ...(model ? { model } : {}), ...modeParams(mode) });
    threads.set(session.id, { session, turnId: null });
  }

  return {
    agent: 'codex',

    // Sync (docs/SYNC.md): names and archive go through Codex's own server, so the Codex app and CLI
    // see them. There's no way to see threads running in other Codex processes, so no running signal.
    sync: { rename: 'native', archive: 'native', running: 'missing' },

    async rename(id, title) {
      await call('thread/name/set', { threadId: id, name: title });
      const s = hub.get(`codex:${id}`);
      if (s) s.title = title;
    },

    async archive(id, on) { await call(on ? 'thread/archive' : 'thread/unarchive', { threadId: id }); },

    // Codex rewrites session_index.jsonl on every rename and moves files into archived_sessions/ on
    // archive, whichever app did it. Undocumented, so only a cue to re-read the list, never parsed.
    watchChanges(onChange) {
      const stops = [];
      let t = null;
      const cue = () => { clearTimeout(t); t = setTimeout(onChange, 500); t.unref?.(); };
      for (const target of [codexHome, join(codexHome, 'archived_sessions')]) {
        try {
          const w = watch(target, (_e, name) => { if (target !== codexHome || name === 'session_index.jsonl') cue(); });
          w.unref?.(); stops.push(() => w.close());
        } catch {}
      }
      return () => { clearTimeout(t); for (const stop of stops) stop(); };
    },

    // Voice chats: Codex lists no text for them, and keeps what was said in its history database
    // (thread_history_1.sqlite, table thread_realtime_items). No API reads it, so this is an
    // undocumented, read-only source: any failure just means no voice chats (docs/SYNC.md).
    async voiceThreads({ cwd, limit = 40, archived = false } = {}) {
      const rows = await voice(`select thread_id as id, max(created_at_ms) as at from thread_realtime_items group by thread_id order by at desc limit ${Number(limit) || 40}`);
      const out = [];
      for (const r of rows) {
        if (!THREAD_ID.test(r.id)) continue;
        const t = (await call('thread/read', { threadId: r.id, includeTurns: false }).catch(() => null))?.thread;
        if (!t || /\/archived_sessions\//.test(t.path || '') !== archived || (cwd && t.cwd !== cwd)) continue; // Codex moves an archived thread's file there
        out.push({ agent: 'codex', id: t.id, cwd: t.cwd, title: t.name || t.preview || 'Voice chat', updatedAt: Math.max(ms(t.updatedAt) || 0, r.at || 0), voice: true });
      }
      return out;
    },

    async list({ cwd, limit = 40, archived = false } = {}) {
      // The state DB answers in milliseconds; without useStateDbOnly the server rescans every
      // rollout file on disk (~45s on this Mac) for the same list.
      // Everything you started: the Codex app/CLI, headless `codex exec` runs, other clients. Codex's own
      // sub-agent threads (hundreds of internal safety checks) stay out; they live inside their parent.
      const res = await call('thread/list', { limit, sortKey: 'updated_at', useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], ...(archived ? { archived: true } : {}), ...(cwd ? { cwd } : {}) });
      const rows = (res.data || []).map((t) => ({
        agent: 'codex', id: t.id, cwd: t.cwd, title: t.name || t.preview || '', updatedAt: ms(t.updatedAt), branch: t.gitInfo?.branch, ...(archived ? { archived: true } : {}),
      }));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const v of await this.voiceThreads({ cwd, limit, archived })) {
        if (byId.has(v.id)) byId.get(v.id).voice = true; // listed already (it has typed turns too)
        else rows.push({ ...v, ...(archived ? { archived: true } : {}) });
      }
      return rows;
    },

    // Turns come page by page (thread/turns/list); loading them all through thread/read is deprecated
    // for long threads. Older Codex builds without it still get thread/read.
    async history(id) {
      let turns = [];
      try {
        let cursor = null;
        for (let page = 0; page < 50; page++) {
          const res = await call('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
          turns.push(...(res.data || []));
          cursor = res.nextCursor;
          if (!cursor) break;
        }
      } catch (e) {
        if (!/method|unknown|not found/i.test(e.message)) throw e;
        turns = (await call('thread/read', { threadId: id, includeTurns: true })).thread?.turns || [];
      }
      // What was said out loud comes first (voice chats start there), then any typed turns.
      const out = THREAD_ID.test(id) ? voiceEvents(await voice(`select item_id, created_at_ms, item_json from thread_realtime_items where thread_id = '${id}' and item_type in ('transcript_segment', 'realtime_session_started', 'realtime_session_closed') order by rollout_ordinal`)) : [];
      for (const turn of turns) {
        for (const item of turn.items || []) { const ev = codexItemEvent(item); if (ev) out.push(ev); }
        if (turn.status && turn.status !== 'inProgress') out.push({ id: `${turn.id}:result`, kind: 'result', ok: turn.status === 'completed', text: turn.error ? friendlyError(turn.error) : undefined, durationMs: turn.durationMs ?? undefined });
      }
      return out;
    },

    async start({ cwd, text, model, mode, effort }) {
      const res = await call('thread/start', { cwd, ...(model ? { model } : {}), ...modeParams(mode) });
      const session = hub.open({ agent: 'codex', id: res.thread.id, cwd, title: text.slice(0, 80) });
      session.model = model || res.model || 'default';
      session.effort = effort || res.reasoningEffort || null;
      threads.set(session.id, { session, turnId: null });
      await this.send(session, text, { model });
      return session;
    },

    async setEffort(session, effort) { session.effort = effort; },

    async send(session, text, { model, mode, effort } = {}) {
      if (effort) session.effort = effort;
      await attach(session, { model, mode });
      const t = threads.get(session.id);
      const input = [{ type: 'text', text }];
      const wasRunning = Boolean(t.turnId);
      session.setStatus('running');
      try {
        if (t.turnId) {
          await call('turn/steer', { threadId: session.id, expectedTurnId: t.turnId, input });
          return;
        }
        const res = await call('turn/start', { threadId: session.id, input, ...(model ? { model } : {}), ...(session.effort ? { effort: session.effort } : {}) });
        if (model) session.model = model;
        t.turnId = res.turn?.id ?? t.turnId;
      } catch (err) {
        if (!wasRunning) session.setStatus('idle'); // the turn never started; don't leave it looking busy
        throw err;
      }
    },

    async interrupt(session) {
      const t = threads.get(session.id);
      session.cancelPending();
      if (t?.turnId) await call('turn/interrupt', { threadId: session.id, turnId: t.turnId }).catch(() => {});
    },

    // Codex has no slash commands over the protocol; its skills are the equivalent. Sending
    // "$name" in a message invokes one, so the composer inserts them with that prefix.
    async commands(session) {
      try {
        const res = await call('skills/list', session?.cwd ? { cwds: [session.cwd] } : {});
        return (res.data || []).flatMap((e) => e.skills || []).filter((s) => s.enabled !== false)
          .map((s) => ({ name: s.name, description: s.shortDescription || s.description || '', prefix: '$' }));
      } catch { return []; }
    },

    async models() {
      try { return ((await call('model/list', {})).data || []).map((m) => ({ id: m.id ?? m.model, name: m.displayName ?? m.id })); } catch { return []; }
    },

    close(session) { threads.delete(session.id); },
    stop() { proc?.kill(); },
    request: (method, params) => call(method, params),
  };
}
