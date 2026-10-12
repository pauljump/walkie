// Antigravity adapter. `agy -p` runs one turn per process and resumes with --conversation, streaming
// its own event format (init / step_update / result). Headless Antigravity can't ask for permission
// (anything that would prompt is auto-denied), so Walkie runs it in a chosen mode instead of per-call
// approvals: "ask" = no shell (edits still need allow rules), "auto" = sandboxed, no prompts.
// Antigravity has no session-list API, so Walkie keeps its own journal of these sessions.

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { clip, shortPath } from './describe.mjs';

export function agyToolEvent(id, step) {
  const info = step.tool_info || {};
  const p = info.parameters || {};
  const name = step.tool_name || info.name || 'tool';
  const path = p.TargetFile || p.AbsolutePath || p.FilePath || p.file_path || p.path;
  const title = p.CommandLine ? `$ ${p.CommandLine}`
    : /write|replace|edit|create/i.test(name) && path ? `Edit ${shortPath(path)}`
      : /view|read/i.test(name) && path ? `Read ${shortPath(path)}`
        : name.replace(/_/g, ' ');
  const status = step.state === 'DONE' ? 'ok' : step.state === 'ERROR' ? 'error' : 'running';
  const err = info.error?.message;
  return { id, kind: 'tool', tool: name, title, status, ...(err ? { output: clip(err) } : {}) };
}

export function makeAgy({ hub, spawn = nodeSpawn, journalDir = join(homedir(), '.walkie', 'journal', 'agy'), log = () => {} }) {
  const running = new Map(); // session key → child
  mkdirSync(journalDir, { recursive: true });
  const journal = (id) => join(journalDir, `${id}.jsonl`);
  const record = (session, ev) => { try { appendFileSync(journal(session.id), `${JSON.stringify({ ...ev, cwd: session.cwd, title: session.title })}\n`); } catch {} };

  const withEffort = (model, effort) => (model && effort && !/-(low|medium|high)$/.test(model) ? `${model}-${effort}` : model);

  function turn(session, text, { model, mode, conversation, effort }) {
    model = withEffort(model, effort);
    const args = ['-p', text, '--output-format', 'stream-json'];
    if (conversation) args.push('--conversation', conversation);
    if (model) args.push('--model', model);
    if (mode === 'auto') args.push('--sandbox', '--dangerously-skip-permissions');
    const env = { ...process.env }; delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY;
    const child = spawn('agy', args, { cwd: session.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(session.key, child);
    session.setStatus('running');
    const texts = new Map(); // step index → text
    let gotInit;
    const init = new Promise((r) => { gotInit = r; });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev; try { ev = JSON.parse(line); } catch { if (line.trim()) session.push({ kind: 'info', text: clip(line, 400) }); return; }
      if (ev.event === 'init') { gotInit(ev.conversation_id || ev.init?.conversation_id); return; }
      if (ev.event === 'step_update') {
        const st = ev.step_update; const id = `${st.conversation_id}:${st.step_index}`;
        if (st.step_type === 'agent_response') {
          if (st.text_delta) { texts.set(id, (texts.get(id) || '') + st.text_delta); session.appendDraft(st.text_delta); }
          if (st.state === 'DONE' && (texts.get(id) || '').trim()) { const e = { id, kind: 'text', text: texts.get(id).trim() }; session.push(e); record(session, e); }
          if (st.usage) hub.emit('turn-usage', { agent: 'agy', model, usage: st.usage });
        } else if (st.step_type === 'tool') {
          const e = agyToolEvent(id, st); session.push(e); if (st.state !== 'ACTIVE') record(session, e);
        }
        return;
      }
      if (ev.event === 'result') {
        const r = ev.result || {};
        const denied = (r.denied_actions || []).map((d) => d.display_name || d.action);
        const e = {
          kind: 'result', ok: r.status === 'SUCCESS' && !denied.length, durationMs: Math.round((r.duration_seconds || 0) * 1000),
          text: denied.length ? `Antigravity was blocked from: ${denied.join(', ')}. Switch this session to Auto (sandboxed) to let it run.` : r.status !== 'SUCCESS' ? r.status : undefined,
        };
        session.push(e); record(session, e);
      }
    });
    child.stderr.on('data', (d) => log(`[agy] ${String(d).trimEnd().slice(0, 300)}`));
    child.on('error', (err) => {
      log(`[agy] couldn't start: ${err.message}`);
      session.push({ kind: 'error', text: err.code === 'ENOENT' ? 'Antigravity isn\'t installed on this Mac (no `agy` on PATH).' : `Antigravity couldn't start: ${err.message}` });
    });
    child.on('close', () => { running.delete(session.key); session.setStatus('idle'); gotInit(null); });
    return init;
  }

  return {
    agent: 'agy',
    async list({ cwd, limit = 40 } = {}) {
      const rows = [];
      for (const f of readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))) {
        let first;
        try { first = JSON.parse(readFileSync(join(journalDir, f), 'utf8').split('\n')[0] || '{}'); } catch { continue; } // one damaged journal hides only itself
        if (cwd && first.cwd !== cwd) continue;
        rows.push({ agent: 'agy', id: f.replace('.jsonl', ''), cwd: first.cwd, title: first.title || '', updatedAt: statSync(join(journalDir, f)).mtimeMs });
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    },
    async history(id) {
      let lines;
      try { lines = readFileSync(journal(id), 'utf8').trim().split('\n'); } catch { return []; }
      return lines.flatMap((l) => { try { const { cwd, title, ...ev } = JSON.parse(l); return [ev]; } catch { return []; } });
    },
    // A new conversation's id only exists once agy starts, so wait for its init line.
    async start({ cwd, text, model, mode, effort }) {
      const tmpKey = `agy:pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pending = { id: 'pending', cwd, title: text.slice(0, 80), key: tmpKey, events: [], draft: '', push() {}, appendDraft() {}, setStatus() {} };
      const buffered = [];
      pending.push = (e) => buffered.push(e);
      const conv = await turn(pending, text, { model, mode: mode || 'auto', effort });
      if (!conv) throw Object.assign(new Error('Antigravity did not start'), { status: 502 });
      const session = hub.open({ agent: 'agy', id: conv, cwd, title: text.slice(0, 80) });
      session.mode = mode || 'auto'; session.model = model || 'default'; session.effort = effort || null;
      const u = session.push({ kind: 'user', text }); record(session, u);
      // Point the running turn at the real session from here on.
      Object.assign(pending, { id: conv, push: (e) => session.push(e), appendDraft: (d) => session.appendDraft(d), setStatus: (s) => session.setStatus(s), key: session.key });
      if (running.has(tmpKey)) { running.set(session.key, running.get(tmpKey)); running.delete(tmpKey); }
      buffered.forEach((e) => session.push(e));
      session.setStatus('running');
      return session;
    },
    async setEffort(session, effort) { session.effort = effort; },

    async send(session, text, { model, mode, effort } = {}) {
      if (effort) session.effort = effort;
      if (running.has(session.key)) throw Object.assign(new Error('Antigravity is still working; wait or stop it first.'), { status: 409 });
      const u = session.push({ kind: 'user', text }); record(session, u);
      if (model) session.model = model;
      turn(session, text, { model: session.model !== 'default' ? session.model : undefined, mode: mode || session.mode || 'auto', conversation: session.id, effort: session.effort });
    },
    async interrupt(session) { running.get(session.key)?.kill('SIGINT'); },
    async commands() { return []; },
    close() {},
    stop() { for (const c of running.values()) c.kill(); },
  };
}
