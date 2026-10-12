// Generic ACP (Agent Client Protocol) adapter. Any CLI that speaks ACP over stdio plugs in with one
// line of config: Grok today (`grok agent stdio`), others later. One long-lived process per agent;
// sessions are ACP sessions, so desk sessions list, load (with history replay) and resume.
// session/request_permission becomes an Allow/Deny card on the phone.

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { clip, editDiff, shortPath } from './describe.mjs';

const text = (c) => (c?.type === 'text' ? c.text : '');

export function acpToolEvent(u, prior = {}) {
  const diffs = (u.content || []).filter((c) => c.type === 'diff').map((c) => editDiff(shortPath(c.path), c.oldText ?? '', c.newText ?? ''));
  const out = (u.content || []).map((c) => (c.type === 'content' ? text(c.content) : '')).filter(Boolean).join('\n');
  const cmd = u.rawInput?.command ?? u.rawInput?.cmd;
  const path = u.locations?.[0]?.path || u.rawInput?.file_path || u.rawInput?.path;
  const title = prior.title && !u.title ? prior.title
    : cmd ? `$ ${Array.isArray(cmd) ? cmd.join(' ') : cmd}`
      : u.kind === 'edit' && path ? `Edit ${shortPath(path)}`
        : u.kind === 'read' && path ? `Read ${shortPath(path)}`
          : u.title || u.toolName || prior.title || 'Tool';
  const status = u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'error' : (prior.status || 'running');
  return {
    id: u.toolCallId, kind: 'tool', tool: u.kind || u.toolName || prior.tool || 'tool', title, status,
    ...(diffs.length ? { diff: clip(diffs.join('\n'), 12000) } : prior.diff ? { diff: prior.diff } : {}),
    ...(out ? { output: clip(out) } : prior.output ? { output: prior.output } : {}),
  };
}

export function makeAcp({ hub, agent, label, command, spawn = nodeSpawn, quickMs = 30_000, log = () => {} }) {
  let proc = null; let ready = null; let nextId = 1;
  const calls = new Map();
  const sessions = new Map();   // sessionId → { session, draft, loading }
  let commands = []; let models = []; let textSeq = 0; let currentModel = null;

  function write(msg) {
    if (!proc?.stdin?.writable) throw new Error(`${label} isn't running.`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }
  // `ms` bounds calls that should answer quickly; a prompt (a whole turn) has no limit.
  function rpc(method, params, ms = 0) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = ms ? setTimeout(() => { if (calls.delete(id)) reject(new Error(`${label} didn't answer ${method} in ${ms / 1000}s`)); }, ms) : null;
      timer?.unref?.();
      calls.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); } catch (err) { calls.delete(id); clearTimeout(timer); reject(err); }
    });
  }
  // The process is gone (exited or never started): fail what's waiting, end live turns, start fresh next time.
  function gone(child, why) {
    if (proc !== child) return;
    for (const c of calls.values()) { clearTimeout(c.timer); c.reject(new Error(why)); }
    calls.clear();
    for (const s of sessions.values()) { s.session.cancelPending(); s.session.setStatus('idle'); }
    sessions.clear(); proc = null; ready = null;
  }
  function boot() {
    if (ready) return ready;
    const child = proc = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    child.on('error', (err) => { log(`[${agent}] couldn't start: ${err.message}`); gone(child, err.code === 'ENOENT' ? `${label} isn't installed on this Mac (no \`${command[0]}\` on PATH).` : `${label} couldn't start: ${err.message}`); });
    child.stdin.on('error', (err) => log(`[${agent}] stdin: ${err.message}`));
    createInterface({ input: child.stdout }).on('line', (l) => { if (l.trim()) { try { onMessage(JSON.parse(l)); } catch (e) { log(`[${agent}] bad line: ${e.message}`); } } });
    child.stderr.on('data', (d) => log(`[${agent}] ${String(d).trimEnd().slice(0, 300)}`));
    child.on('exit', (code) => { log(`[${agent}] exited (${code})`); gone(child, `${label} stopped unexpectedly. Send again to restart it.`); });
    ready = rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'walkie', version: '3.0.0' } }, 30_000)
      .catch((err) => { ready = null; throw err; });
    return ready;
  }
  const call = async (m, p, ms = quickMs) => { await boot(); return rpc(m, p, ms); };

  function flush(s) {
    if (!s.draft) return;
    s.session.push({ id: `${s.session.id}:t${s.session.events.length}:${++textSeq}`, kind: 'text', text: s.draft });
    s.draft = '';
  }

  function onMessage(m) {
    if (m.id != null && !m.method) {
      const c = calls.get(m.id); if (!c) return; calls.delete(m.id); clearTimeout(c.timer);
      if (m.error) c.reject(new Error(m.error.message || `${label} error`)); else c.resolve(m.result);
      return;
    }
    if (m.id != null && m.method) { onRequest(m).catch((e) => { try { write({ id: m.id, error: { code: -32603, message: e.message } }); } catch {} }); return; }
    const p = m.params || {};
    if (m.method === '_x.ai/models/update' && p.currentModelId) currentModel = p.currentModelId;
    if (m.method === '_x.ai/models/update' && p.availableModels) models = p.availableModels.map((x) => ({ id: x.modelId, name: x.name, description: x.description }));
    if (m.method !== 'session/update') return;
    const u = p.update || {};
    if (u.sessionUpdate === 'available_commands_update') { commands = (u.availableCommands || []).map((c) => ({ name: c.name, description: c.description })); return; }
    const s = sessions.get(p.sessionId);
    if (!s) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': s.draft += text(u.content); s.session.appendDraft(text(u.content)); break;
      case 'user_message_chunk': {
        if (!s.loading) break; // live turns: we already pushed what the user typed
        flush(s);
        const last = s.session.events.at(-1);
        if (last?.kind === 'user') s.session.push({ ...last, text: last.text + text(u.content) });
        else s.session.push({ id: `${s.session.id}:u${s.session.events.length}`, kind: 'user', text: text(u.content) });
        break;
      }
      case 'agent_thought_chunk': break;
      case 'tool_call': flush(s); s.session.push(acpToolEvent(u)); break;
      case 'tool_call_update': { const prior = s.session.events.find((e) => e.id === u.toolCallId) || {}; s.session.push(acpToolEvent(u, prior)); break; }
      case 'plan': flush(s); s.session.push({ id: `${s.session.id}:plan`, kind: 'info', text: (u.entries || []).map((e) => `${e.status === 'completed' ? '✓' : '·'} ${e.content}`).join('\n') }); break;
      default: break;
    }
  }

  async function onRequest({ id, method, params: p }) {
    const s = sessions.get(p.sessionId);
    if (method !== 'session/request_permission' || !s) { write({ id, error: { code: -32601, message: `Walkie does not handle ${method}` } }); return; }
    flush(s);
    const t = acpToolEvent(p.toolCall || {});
    const options = (p.options || []).map((o) => ({ id: o.optionId, label: o.name, style: /reject/.test(o.kind) ? 'destructive' : undefined }));
    const reply = await s.session.ask({ type: 'permission', tool: t.tool, title: t.title, diff: t.diff, options });
    write({ id, result: { outcome: reply.cancelled || !reply.choice ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reply.choice } } });
  }

  async function prompt(s, textIn) {
    s.session.setStatus('running');
    const t0 = Date.now();
    try {
      const r = await call('session/prompt', { sessionId: s.session.id, prompt: [{ type: 'text', text: textIn }] }, 0);
      flush(s);
      s.session.push({ kind: 'result', ok: r?.stopReason === 'end_turn', text: r?.stopReason && r.stopReason !== 'end_turn' ? r.stopReason : undefined, durationMs: Date.now() - t0 });
    } catch (e) {
      flush(s);
      s.session.push({ kind: 'error', text: e.message });
      s.session.push({ kind: 'result', ok: false, text: e.message, durationMs: Date.now() - t0 });
    } finally {
      s.session.setStatus('idle');
    }
  }

  async function attach(session) {
    if (sessions.has(session.id)) return sessions.get(session.id);
    const s = { session, draft: '', loading: false };
    sessions.set(session.id, s);
    await call('session/resume', { sessionId: session.id, cwd: session.cwd, mcpServers: [] })
      .catch(() => call('session/load', { sessionId: session.id, cwd: session.cwd, mcpServers: [] }));
    return s;
  }

  return {
    agent,
    async list({ cwd, limit = 40 } = {}) {
      try {
        const r = await call('session/list', cwd ? { cwd } : {});
        return (r.sessions || []).slice(0, limit).map((x) => ({
          agent, id: x.sessionId, cwd: x.cwd, title: x.title || x.summary || '', updatedAt: x.updatedAt ? Date.parse(x.updatedAt) || x.updatedAt : undefined,
        }));
      } catch { return []; }
    },
    // Loading a session makes the agent replay it as session/update notifications.
    async history(id, { cwd } = {}) {
      const scratch = { id, events: [], draft: '', push(ev) { const e = { id: ev.id || `${id}:${this.events.length}`, ...ev }; const i = this.events.findIndex((x) => x.id === e.id); if (i >= 0) this.events[i] = e; else this.events.push(e); }, appendDraft() {}, setStatus() {}, cancelPending() {}, ask: async () => ({ cancelled: true }) };
      const s = { session: scratch, draft: '', loading: true };
      sessions.set(id, s);
      try { await call('session/load', { sessionId: id, cwd: cwd || process.cwd(), mcpServers: [] }, 60_000); flush(s); }
      catch { /* not loadable: empty history */ }
      finally { sessions.delete(id); }
      return scratch.events;
    },
    async start({ cwd, text: t, model }) {
      const r = await call('session/new', { cwd, mcpServers: [] });
      const session = hub.open({ agent, id: r.sessionId, cwd, title: t.slice(0, 80) });
      session.model = model || currentModel || 'default';
      const s = { session, draft: '', loading: false };
      sessions.set(session.id, s);
      if (model) await call('session/set_model', { sessionId: session.id, modelId: model }).catch((e) => log(`[${agent}] set_model: ${e.message}`));
      session.push({ kind: 'user', text: t });
      prompt(s, t);
      return session;
    },
    async send(session, t, { model } = {}) {
      const s = await attach(session);
      if (model && model !== session.model) {
        await call('session/set_model', { sessionId: session.id, modelId: model }).then(() => { session.model = model; }).catch((e) => log(`[${agent}] set_model: ${e.message}`));
      }
      session.push({ kind: 'user', text: t });
      prompt(s, t);
    },
    async interrupt(session) {
      session.cancelPending();
      if (proc) { try { write({ method: 'session/cancel', params: { sessionId: session.id } }); } catch {} }
    },
    async commands() { await boot().catch(() => {}); return commands; },
    async models() { return models; },
    close(session) { sessions.delete(session.id); },
    stop() { proc?.kill(); },
  };
}
