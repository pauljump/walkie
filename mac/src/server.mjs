// HTTP + WebSocket surface the phone talks to. Everything except /api/status needs the bridge key
// (x-api-key header, or ?key= on the WebSocket upgrade for clients that can't set headers).
//
//   GET  /api/status                    unauthenticated liveness + version
//   GET  /api/projects                  folders you can start a session in (names and hidden from ~/.walkie/walkie.json)
//   GET  /api/asks?cwd=                 quick asks for a folder: the project's, then global (~/.walkie/walkie.json)
//   GET  /api/sessions?cwd=             every agent's sessions, newest first, live ones flagged
//   GET  /api/sessions?archived=1       everything archived, in the agent's own record or Walkie-only
//   GET  /api/search?q=                 conversations whose title or text matches (open and archived)
//   POST /api/upload                    raw body; content-type image/*, PDF or text; x-walkie-filename,
//                                       x-walkie-conversation → { path, name, type, size } (≤ 20 MB)
//   GET  /api/upload?path=              an uploaded file back (only from ~/.walkie/uploads)
//   GET  /api/session?key=&since=&epoch= one session's events (live log, or history from the CLI);
//                                       with since+epoch from the same live log, only newer events (partial: true)
//   POST /api/session                   { agent, cwd, text, model?, mode?, effort?, continueFrom?, clientId? } → new session
//                                       (continueFrom: a session key; the new one starts with that conversation)
//   POST /api/session/send              { key, text, model?, clientId? }
//   POST /api/session/plan              { key, cwd? } ask this conversation's agent to split it into one brief per project
//   POST /api/dispatch                  { from, tasks: [{ cwd, agent, model?, mode?, effort?, brief }], clientId? }
//                                       → { sessions, failed } one new session per task; `from` gets a link to each
//   POST /api/session/answer            { key, askId, choice? | answers?, message? }
//   POST /api/session/interrupt         { key }
//   POST /api/session/effort            { key, effort }
//   POST /api/session/rename            { key, title, cwd? } in the agent's own record when it has one (docs/SYNC.md)
//   POST /api/session/archive           { key, archived?: true|false, cwd? } likewise; Walkie-only when it can't
//   GET  /api/commands?key=|agent=      slash commands / skills for the composer
//   GET  /api/usage?fresh=1             what's left on each subscription
//   GET  /api/models?fresh=1            every model across every subscription
//   POST /api/devices                   { token, env } register the phone for push
//   GET  /ws                            live frames: hello | event | draft | status | session | closed
//                                       | sessions (a list changed: started, stopped, renamed or archived)
//                                       | customize (~/.walkie/walkie.json changed: re-read projects and asks)
//                                       (phone → bridge: { type: 'presence', foreground } | { type: 'ping' } → pong)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, statSync, existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import { handoffText, planPrompt } from './handoff.mjs';

const VERSION = 3;
// Wire compatibility (research/fundamentals/protocol-versioning.md). Bump PROTOCOL.max for a breaking
// change and keep min at the oldest phone build still served. Additive features are capabilities.
export const PROTOCOL = { min: 1, max: 1 };
export const CAPABILITIES = ['sessions-frame', 'rename', 'archive', 'event-seq', 'client-id-echo', 'archived-list', 'voice-events', 'search', 'attachments', 'continue', 'ping', 'customize'];

const LABELS = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', grok: 'Grok' };
// A list call that hangs (a CLI wedged on startup) must not hang the phone's screen with it.
const LIST_TIMEOUT_MS = 15_000;

// The Mini's memory admission check: one line on a new session when memory is tight. It only ever warns.
const MINI = join(homedir(), 'projects/_factory/control-plane/scripts/mini.mjs');
export function miniAdmission(agent) {
  if (!existsSync(MINI)) return Promise.resolve(null);
  return new Promise((resolve) => execFile('node', [MINI, 'can', agent === 'codex' ? 'codex' : 'claude', '--json'], { timeout: 15000 }, (_e, out) => {
    try {
      const v = JSON.parse(String(out || ''));
      if (!v?.answer || v.answer === 'ok') return resolve(null);
      const room = (v.suggestions?.shutdown || []).slice(0, 3).map((s) => s.what).join('; ');
      resolve(`Mac memory: ${v.answer.toUpperCase()} for a new ${v.kind} session (${v.reason}). ${room ? 'To make room: ' + room + '.' : ''}`.trim());
    } catch { resolve(null); }
  }));
}

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); t.unref?.(); })])
    .finally(() => clearTimeout(t));
}

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1_000_000) { reject(fail(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(fail(400, 'invalid json')); } });
    req.on('error', reject);
  });
}

export function listProjectDirs(roots) {
  const out = [];
  for (const root of roots) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const path = join(root, name);
      try {
        const st = statSync(path);
        if (st.isDirectory() && existsSync(join(path, '.git'))) out.push({ path, name, updatedAt: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

export function makeServer({ hub, adapters, apiKey, projectRoots = [], push = null, usage = null, models = null, customize = null, admission = async () => null, listTimeoutMs = LIST_TIMEOUT_MS, log = () => {} }) {
  // clientId → what that request returned, so a retried send never runs twice. Kept on disk so a
  // message the phone queued survives a bridge restart without running again.
  const walkieDir = join(process.env.HOME || '', '.walkie');
  const clientIdsPath = join(walkieDir, 'client-ids.json');
  const recentClientIds = new Map((() => { try { return JSON.parse(readFileSync(clientIdsPath, 'utf8')); } catch { return []; } })());
  const inFlight = new Map(); // clientId → the promise of its first run
  let saveIds = null;
  const rememberClientId = (id, value) => {
    recentClientIds.set(id, value);
    if (recentClientIds.size > 1000) for (const k of [...recentClientIds.keys()].slice(0, recentClientIds.size - 1000)) recentClientIds.delete(k);
    clearTimeout(saveIds);
    saveIds = setTimeout(() => { try { mkdirSync(walkieDir, { recursive: true }); writeFileSync(clientIdsPath, JSON.stringify([...recentClientIds])); } catch {} }, 200);
    saveIds.unref?.();
  };
  // Run fn once per clientId: a duplicate gets the first answer (waiting for it if it's still running,
  // e.g. the phone timed out and retried a slow start), and a retry after a failure runs again.
  async function once(clientId, fn, duplicate = (v) => ({ duplicate: true, ...(v && v !== true ? { session: v } : {}) })) {
    if (!clientId) return fn();
    if (recentClientIds.has(clientId)) return duplicate(recentClientIds.get(clientId));
    const kept = (r) => r?.session || r || true; // what a duplicate needs: the session, or the whole answer
    if (inFlight.has(clientId)) return duplicate(kept(await inFlight.get(clientId)));
    const run = (async () => { const r = await fn(); rememberClientId(clientId, kept(r)); return r; })();
    inFlight.set(clientId, run);
    try { return await run; } finally { inFlight.delete(clientId); }
  }
  const byAgent = (agent) => adapters[agent] || null;
  const needAgent = (agent) => byAgent(agent) || (() => { throw fail(400, `agent must be one of: ${Object.keys(adapters).join(', ')}`); })();

  function sessionFromKey(key) {
    const [agent, ...rest] = String(key || '').split(':');
    return { agent, id: rest.join(':') };
  }

  // Make a stored session live: load its history into the hub so new events append to it.
  async function openSession(key, cwd) {
    const live = hub.get(key);
    if (live) return live;
    const { agent, id } = sessionFromKey(key);
    const adapter = byAgent(agent);
    if (!adapter || !id) throw fail(404, 'unknown session');
    const events = await adapter.history(id, { cwd });
    const listed = cwd ? (await withTimeout(adapter.list({ cwd }), listTimeoutMs, `${agent} list`).catch(() => [])).find((s) => s.id === id) : null;
    const session = hub.get(key) || hub.open({ agent, id, cwd: cwd || listed?.cwd, title: listed?.title || '' });
    if (!session.events.length) session.events = events;
    session.resumed = true;
    return session;
  }

  // Sync (docs/SYNC.md). The agent's own record is the truth; Walkie only keeps what an agent can't
  // store, in ~/.walkie/overlay.json → { archived: [key…], titles: { key: title } }.
  const overlayPath = join(walkieDir, 'overlay.json');
  const readOverlay = () => {
    let o = {};
    try { o = JSON.parse(readFileSync(overlayPath, 'utf8')); } catch {}
    return { archived: new Set(o.archived || []), titles: o.titles || {} };
  };
  const writeOverlay = (o) => {
    mkdirSync(walkieDir, { recursive: true });
    writeFileSync(overlayPath, JSON.stringify({ archived: [...o.archived], titles: o.titles }, null, 2));
  };
  async function setArchived(key, on, cwd) {
    const { agent, id } = sessionFromKey(key);
    const a = byAgent(agent);
    if (a?.archive) await a.archive(id, on, { cwd });
    const o = readOverlay(); // clear any Walkie-only copy either way, so the agent's answer is the one that counts
    if (on && !a?.archive) o.archived.add(key); else o.archived.delete(key);
    writeOverlay(o);
    hub.emit('frame', { type: 'sessions' });
  }

  // "Open" is what you'd expect: running somewhere on this Mac, or held by Walkie. A session we watched
  // stop (closed in the terminal or the desktop app) drops to Earlier right away.
  const OPEN_GRACE_MS = 2 * 3600 * 1000;
  const ended = new Map(); // key → when we saw it stop running
  let wasRunning = null;
  let polling = null;
  const pollRunning = () => (polling ||= (async () => {
    const now = new Set();
    for (const a of Object.values(adapters)) {
      if (!a.runningIds) continue;
      try { for (const id of await withTimeout(a.runningIds({ fresh: true }), listTimeoutMs, `${a.agent} running`)) now.add(`${a.agent}:${id}`); } catch (e) { log(`[running ${a.agent}] ${e.message}`); return; }
    }
    if (wasRunning) {
      let changed = false;
      for (const k of wasRunning) if (!now.has(k)) { changed = true; if (!hub.get(k)) ended.set(k, Date.now()); }
      for (const k of now) if (!wasRunning.has(k)) { changed = true; ended.delete(k); }
      if (changed) hub.emit('frame', { type: 'sessions' });
    }
    wasRunning = now;
  })().finally(() => { polling = null; }));
  pollRunning();
  // Event-driven where the agent gives us a cue, plus a slow sweep for sessions that die without one.
  const unwatch = Object.values(adapters).map((a) => a.watchRunning?.(pollRunning)).filter(Boolean);
  // Renamed or archived in the agent's own app: tell the phone to re-read.
  for (const a of Object.values(adapters)) { const u = a.watchChanges?.(() => hub.emit('frame', { type: 'sessions' })); if (u) unwatch.push(u); }
  const runningPoll = setInterval(pollRunning, 15_000);
  runningPoll.unref?.();
  // An agent that reports what's running (Claude) is believed outright: stopped means closed, even
  // across a bridge restart. The recency grace is only for agents with no running signal.
  const reportsRunning = (agent) => byAgent(agent)?.sync?.running === 'native';
  const isOpen = (r) => !!(r.running || r.live || (!reportsRunning(r.agent) && !ended.has(r.key) && Date.now() - (r.updatedAt || 0) < OPEN_GRACE_MS));

  // Scratch folders (temp dirs) aren't projects.
  const scratch = (p) => /^\/(private\/)?(tmp|var\/folders)\//.test(p || '');

  // One agent's list, never longer than LIST_TIMEOUT_MS and never an exception: a broken CLI just lists nothing.
  const listOf = (a, opts) => withTimeout(a.list(opts), listTimeoutMs, `${a.agent} list`).catch((err) => { log(`[list ${a.agent}] ${err.message}`); return []; });

  // Older phone builds only decode some agents; they send x-walkie-agents.
  async function allSessions(cwd, clientAgents = null) {
    const visible = Object.values(adapters).filter((a) => !clientAgents || clientAgents.includes(a.agent));
    const lists = await Promise.all(visible.map((a) => listOf(a, { cwd })));
    const { archived: hidden, titles } = readOverlay();
    const rows = lists.flat().filter((s) => (cwd || !scratch(s.cwd)) && !hidden.has(`${s.agent}:${s.id}`)).map((s) => {
      const key = `${s.agent}:${s.id}`;
      return { ...s, key, title: titles[key] || s.title, status: 'idle', live: false };
    });
    for (const s of hub.sessions.values()) {
      if (cwd && s.cwd !== cwd) continue;
      if (clientAgents && !clientAgents.includes(s.agent)) continue;
      if (hidden.has(s.key)) continue;
      const i = rows.findIndex((r) => r.key === s.key);
      const merged = { ...(i >= 0 ? rows[i] : {}), ...s.summary(), title: titles[s.key] || rows[i]?.title || s.title || '' };
      if (i >= 0) rows[i] = merged; else rows.push(merged);
    }
    for (const r of rows) r.open = isOpen(r);
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Archived anywhere: in the agent's own record (Claude tag, Codex archive) or Walkie-only.
  async function archivedSessions(clientAgents = null) {
    const visible = Object.values(adapters).filter((a) => !clientAgents || clientAgents.includes(a.agent));
    const native = await Promise.all(visible.map((a) => (a.archive ? listOf(a, { archived: true, limit: 100 }) : [])));
    const { archived: hidden } = readOverlay();
    const local = hidden.size ? (await Promise.all(visible.map((a) => listOf(a, { limit: 200 })))).flat().filter((s) => hidden.has(`${s.agent}:${s.id}`)) : [];
    const rows = new Map();
    for (const s of [...native.flat(), ...local]) rows.set(`${s.agent}:${s.id}`, { ...s, key: `${s.agent}:${s.id}`, archived: true, status: 'idle', live: false, open: false });
    return [...rows.values()].filter((s) => !scratch(s.cwd)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Search across conversations: titles from every agent's list, plus the text of Claude and Codex
  // transcripts on this Mac (a plain file search with a time limit, so a huge history can't hang it).
  const grepFiles = (q, dir) => new Promise((resolve) => {
    execFile('/usr/bin/grep', ['-rliF', '--include=*.jsonl', '--', q, dir], { timeout: 8000, maxBuffer: 8 << 20 }, (_e, out) => resolve(String(out || '').split('\n').filter(Boolean)));
  });
  async function search(q, agents) {
    const needle = q.toLowerCase();
    const [open, closed] = await Promise.all([allSessions(undefined, agents), archivedSessions(agents)]);
    const byKey = new Map([...closed, ...open].map((s) => [s.key, s]));
    const hits = new Map();
    for (const s of byKey.values()) if ((s.title || '').toLowerCase().includes(needle)) hits.set(s.key, { ...s, match: 'title' });
    const home = process.env.HOME || '';
    const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
    const [claudeFiles, codexFiles] = await Promise.all([
      agents.includes('claude') ? grepFiles(q, join(home, '.claude', 'projects')) : [],
      agents.includes('codex') ? grepFiles(q, join(home, '.codex', 'sessions')) : [],
    ]);
    for (const [agent, files] of [['claude', claudeFiles], ['codex', codexFiles]]) {
      for (const f of files) {
        if (/\/(subagents|tool-results)\//.test(f)) continue;
        const id = f.match(uuid)?.[1];
        const key = id && `${agent}:${id}`;
        if (!key || hits.has(key) || !byKey.has(key)) continue; // only conversations Walkie lists (open or archived)
        hits.set(key, { ...byKey.get(key), match: 'text' });
      }
    }
    return [...hits.values()].sort((a, b) => (a.match === b.match ? (b.updatedAt || 0) - (a.updatedAt || 0) : a.match === 'title' ? -1 : 1)).slice(0, 50);
  }

  // The first message of a conversation continued from another one (handoff.mjs).
  async function continued(fromKey, text, cwd) {
    const { agent, id } = sessionFromKey(fromKey);
    const a = byAgent(agent);
    if (!a || !id) throw fail(404, 'unknown session to continue from');
    const live = hub.get(fromKey);
    const events = live?.events || await a.history(id, { cwd }).catch(() => []);
    const title = live?.title || readOverlay().titles[fromKey] || '';
    return { text: handoffText({ from: LABELS[agent] || agent, title, cwd: live?.cwd || cwd, events, text }), from: live };
  }

  const routes = {
    'GET /api/projects': async (_b, q) => {
      const dirs = new Map(listProjectDirs(projectRoots).map((p) => [p.path, p]));
      for (const s of await allSessions(undefined, q.get('_agents').split(','))) {
        if (!s.cwd) continue;
        const prior = dirs.get(s.cwd);
        if (!prior) dirs.set(s.cwd, { path: s.cwd, name: basename(s.cwd), updatedAt: s.updatedAt });
        else prior.updatedAt = Math.max(prior.updatedAt || 0, s.updatedAt || 0);
      }
      // Your names and hidden projects (~/.walkie/walkie.json).
      const projects = [...dirs.values()].flatMap((p) => {
        const c = customize?.project(p.path);
        if (c?.hidden) return [];
        return [c?.name ? { ...p, name: c.name } : p];
      });
      return { projects: projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
    },
    'GET /api/asks': async (_b, q) => ({ asks: customize ? customize.asks(q.get('cwd') || null) : [] }),
    'GET /api/sessions': async (_b, q) => {
      if (q.get('archived') === '1') return { sessions: await archivedSessions(q.get('_agents').split(',')) };
      return { sessions: await allSessions(q.get('cwd') || undefined, q.get('_agents').split(',')) };
    },
    'GET /api/search': async (_b, q) => {
      const text = String(q.get('q') || '').trim();
      if (text.length < 2) return { results: [] };
      return { results: await search(text.slice(0, 200), q.get('_agents').split(',')) };
    },
    'GET /api/session': async (_b, q) => {
      const key = q.get('key');
      const live = hub.get(key);
      if (live) {
        // Catch-up: only what changed after the phone's last seq, when it's from this same log.
        const newer = q.has('since') ? live.since(Number(q.get('since')), q.get('epoch')) : null;
        return newer ? { session: live.summary(), events: newer, draft: live.draft, partial: true } : { session: live.summary(), events: live.events, draft: live.draft };
      }
      const { agent, id } = sessionFromKey(key);
      const adapter = byAgent(agent);
      if (!adapter || !id) throw fail(404, 'unknown session');
      const events = await adapter.history(id, { cwd: q.get('cwd') || undefined });
      return { session: { key, agent, id, status: 'idle', live: false, title: readOverlay().titles[key] }, events, draft: '' };
    },
    'POST /api/session': async (b) => {
      const adapter = needAgent(b.agent);
      if (!b.cwd || !existsSync(b.cwd)) throw fail(400, 'That folder no longer exists on your Mac.');
      if (!String(b.text || '').trim()) throw fail(400, 'text required');
      return once(b.clientId, async () => {
        const handoff = b.continueFrom ? await continued(String(b.continueFrom), String(b.text), b.cwd) : null;
        const note = await admission(b.agent); // warns, never blocks
        const session = await adapter.start({ cwd: b.cwd, text: handoff?.text || b.text, model: b.model, mode: b.mode, effort: b.effort });
        if (note) session.push({ kind: 'info', text: note });
        if (handoff?.from) handoff.from.push({ kind: 'info', text: `Continued in ${LABELS[session.agent] || session.agent}`, link: session.key });
        return { session: session.summary() };
      });
    },
    'POST /api/session/send': async (b) => {
      if (!String(b.text || '').trim()) throw fail(400, 'text required');
      return once(b.clientId, async () => {
        const { agent, id } = sessionFromKey(b.key);
        if (!hub.get(b.key) && await byAgent(agent)?.runningElsewhere?.(id)) {
          throw fail(409, 'This conversation is open in another app on your Mac (a terminal or the Claude app). Close it there to continue here.', 'running_elsewhere');
        }
        const session = await openSession(b.key, b.cwd);
        if (b.clientId) session.nextClientId = { id: String(b.clientId), at: Date.now() };
        await byAgent(session.agent).send(session, b.text, { model: b.model, mode: b.mode, effort: b.effort });
        return { session: session.summary() };
      }, () => ({ duplicate: true }));
    },
    'POST /api/session/plan': async (b) => {
      const session = await openSession(b.key, b.cwd);
      if (session.status !== 'idle') throw fail(409, 'Wait for the current turn to finish, then send it to projects.');
      const recent = listProjectDirs(projectRoots).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 150).map((p) => p.path);
      const projects = [...new Set([session.cwd, ...recent].filter(Boolean))];
      await byAgent(session.agent).send(session, planPrompt(projects), {});
      return { session: session.summary() };
    },
    // One new session per task, started one after another so a busy Mac isn't asked for ten CLIs at once.
    // A task that fails to start doesn't stop the rest; the phone shows which ones failed and why.
    'POST /api/dispatch': async (b) => {
      const tasks = Array.isArray(b.tasks) ? b.tasks.slice(0, 20) : [];
      if (!tasks.length) throw fail(400, 'no tasks');
      return once(b.clientId, async () => {
        const from = b.from ? hub.get(String(b.from)) || await openSession(String(b.from)).catch(() => null) : null;
        const sessions = []; const failed = [];
        for (const t of tasks) {
          try {
            const adapter = needAgent(t.agent);
            if (!t.cwd || !existsSync(t.cwd)) throw fail(400, `${t.cwd || 'That folder'} doesn't exist on your Mac.`);
            if (!String(t.brief || '').trim()) throw fail(400, 'empty brief');
            const note = await admission(t.agent);
            const s = await adapter.start({ cwd: t.cwd, text: String(t.brief), model: t.model, mode: t.mode, effort: t.effort });
            if (note) s.push({ kind: 'info', text: note });
            if (from) {
              s.push({ kind: 'info', text: `Started from "${(from.title || 'a planning conversation').slice(0, 60)}"`, link: from.key });
              from.push({ kind: 'info', text: `Started in ${basename(t.cwd)} · ${LABELS[s.agent] || s.agent}`, link: s.key });
            }
            sessions.push(s.summary());
          } catch (err) {
            failed.push({ cwd: t.cwd, error: err.message });
            log(`[dispatch] ${t.cwd}: ${err.message}`);
          }
        }
        hub.emit('frame', { type: 'sessions' });
        return { sessions, failed };
      }, (v) => ({ sessions: [], failed: [], ...(v && v !== true ? v : {}), duplicate: true }));
    },
    'POST /api/session/answer': async (b) => {
      const session = hub.get(b.key);
      if (!session || !session.answer(b.askId, { choice: b.choice, answers: b.answers, message: b.message })) {
        throw fail(409, 'That question was already answered or the turn ended.');
      }
      return { ok: true };
    },
    'POST /api/session/interrupt': async (b) => {
      const session = hub.get(b.key);
      if (session) await byAgent(session.agent).interrupt(session);
      return { ok: true };
    },
    'POST /api/session/effort': async (b) => {
      const session = await openSession(b.key, b.cwd);
      const a = byAgent(session.agent);
      if (!a.setEffort) throw fail(501, `${LABELS[session.agent]} doesn't let Walkie change effort`);
      await a.setEffort(session, String(b.effort));
      hub.emit('frame', { type: 'status', key: session.key, status: session.status, session: session.summary() });
      return { session: session.summary() };
    },
    'POST /api/session/rename': async (b) => {
      const title = String(b.title || '').trim().slice(0, 200);
      if (!title) throw fail(400, 'title required');
      const { agent, id } = sessionFromKey(b.key);
      const a = byAgent(agent);
      if (!a || !id) throw fail(404, 'unknown session');
      const o = readOverlay();
      if (a.rename) { await a.rename(id, title, { cwd: b.cwd }); delete o.titles[b.key]; } else o.titles[b.key] = title;
      writeOverlay(o);
      const live = hub.get(b.key);
      if (live) { live.title = title; hub.emit('frame', { type: 'session', session: live.summary() }); }
      hub.emit('frame', { type: 'sessions' });
      return { ok: true, title, where: a.rename ? agent : 'walkie' };
    },
    'POST /api/session/archive': async (b) => {
      const { agent, id } = sessionFromKey(b.key);
      if (!byAgent(agent) || !id) throw fail(404, 'unknown session');
      const on = b.archived !== false;
      await setArchived(b.key, on, b.cwd);
      if (on && hub.get(b.key)?.status === 'idle') { byAgent(agent).close?.(hub.get(b.key)); hub.close(b.key); }
      return { ok: true, archived: on, where: byAgent(agent).archive ? agent : 'walkie' };
    },
    'GET /api/commands': async (_b, q) => {
      const session = q.get('key') ? hub.get(q.get('key')) : null;
      const adapter = byAgent(session?.agent || q.get('agent'));
      return { commands: adapter ? await withTimeout(adapter.commands(session), listTimeoutMs, 'commands').catch(() => []) : [] };
    },
    'GET /api/usage': async (_b, q) => {
      if (!usage) throw fail(501, 'usage not available');
      return usage.all({ fresh: q.get('fresh') === '1' });
    },
    'GET /api/models': async (_b, q) => {
      if (!models) throw fail(501, 'models not available');
      return { models: (await models.all({ fresh: q.get('fresh') === '1' })).models };
    },
    'POST /api/devices': async (b) => {
      if (!push) throw fail(501, 'push not available');
      return push.register(b);
    },
  };

  // Attachments: raw uploads from the phone (up to 20 MB), saved where any agent can read them.
  const UPLOAD_MAX = 20 * 1024 * 1024;
  const UPLOAD_TYPES = /^(image\/(jpeg|png|heic|heif|gif|webp)|application\/pdf|text\/(plain|markdown|csv)|application\/json)$/;
  const uploadsRoot = join(walkieDir, 'uploads');
  function receiveUpload(req, res, send) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!UPLOAD_TYPES.test(type)) return send(415, { error: 'Walkie takes images, PDFs and text files.' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > UPLOAD_MAX) return send(413, { error: 'That file is over 20 MB.' });
    const where = String(req.headers['x-walkie-conversation'] || 'new').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 80);
    const name = String(req.headers['x-walkie-filename'] || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').slice(-80) || 'file';
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => { size += c.length; if (size > UPLOAD_MAX) { over = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (over) return;
      try {
        const dir = join(uploadsRoot, where);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${Date.now()}-${name}`);
        writeFileSync(path, Buffer.concat(chunks));
        send(200, { path, name, type, size });
      } catch (err) { send(500, { error: `Couldn't save that file on the Mac: ${err.message}` }); }
    });
    req.on('close', () => { if (over) { try { send(413, { error: 'That file is over 20 MB.' }); } catch {} } });
  }
  // Serve an uploaded file back (thumbnails on the phone); only from the uploads folder.
  function serveUpload(url, res, send) {
    const p = String(url.searchParams.get('path') || '');
    let real; try { real = realpathSync(p); } catch { return send(404, { error: 'not found' }); }
    const root = (() => { try { return realpathSync(uploadsRoot); } catch { return uploadsRoot; } })();
    if (!real.startsWith(`${root}/`)) return send(403, { error: 'not an upload' });
    const ext = real.split('.').pop().toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=86400' });
    res.end(readFileSync(real));
  }

  const startedAt = Date.now();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://walkie');
    const send = (status, body) => { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/status') return send(200, { ok: true, app: 'walkie', version: VERSION, protocol: PROTOCOL, capabilities: CAPABILITIES, agents: Object.keys(adapters), push: Boolean(push?.enabled?.()), uptimeS: Math.round((Date.now() - startedAt) / 1000) });
    if (!safeEqual(req.headers['x-api-key'], apiKey)) return send(401, { error: 'unauthorized' });
    if (req.method === 'POST' && url.pathname === '/api/upload') return receiveUpload(req, res, send);
    if (req.method === 'GET' && url.pathname === '/api/upload') return serveUpload(url, res, send);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(404, { error: 'not_found' });
    url.searchParams.set('_agents', String(req.headers['x-walkie-agents'] || 'claude,codex'));
    // Phones that know about protocol ranges send "min-max"; no overlap is a clear error, not odd failures.
    const theirs = String(req.headers['x-walkie-protocol'] || '').match(/^(\d+)-(\d+)$/);
    if (theirs && (Number(theirs[2]) < PROTOCOL.min || Number(theirs[1]) > PROTOCOL.max)) {
      return send(426, { error: Number(theirs[2]) < PROTOCOL.min ? 'Update Walkie on your phone to keep using this Mac.' : 'Update the Walkie bridge on your Mac to use this phone build.', code: 'incompatible_protocol', protocol: PROTOCOL });
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(200, await route(body, url.searchParams));
    } catch (err) {
      log(`[http] ${req.method} ${url.pathname}: ${err.message}`);
      send(err.status || 500, { error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://walkie');
    const key = req.headers['x-api-key'] || url.searchParams.get('key');
    if (url.pathname !== '/ws' || !safeEqual(key, apiKey)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.foreground = true; // a socket only exists while the app is open; the app says when it leaves
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', (err) => log(`[ws] ${err.message}`));
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data); } catch { return; }
        ws.isAlive = true;
        if (m.type === 'presence') ws.foreground = Boolean(m.foreground);
        // The phone's own liveness check: a socket that stops answering gets replaced on its side.
        if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: m.id ?? null }));
      });
      ws.send(JSON.stringify({ type: 'hello', version: VERSION, protocol: PROTOCOL, capabilities: CAPABILITIES, sessions: [...hub.sessions.values()].map((s) => s.summary()) }));
    });
  });
  hub.on('frame', (frame) => {
    const data = JSON.stringify(frame);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 25_000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); clearInterval(runningPoll); for (const u of unwatch) u(); customize?.close?.(); });

  // Is the phone looking at Walkie right now? Push stays quiet while it is.
  server.isForeground = () => [...wss.clients].some((ws) => ws.readyState === 1 && ws.foreground);
  return server;
}
