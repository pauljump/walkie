// Personalization without a settings screen: ~/.walkie/walkie.json is a small contract any of your
// agents can edit when you ask ("add a Walkie quick ask that runs the tests"). Walkie reads it, never
// writes it, and tells the phone when it changes.
//
//   {
//     "asks": [ { "title": "Run the tests", "text": "Run the test suite and fix what fails." } ],
//     "projects": {
//       "/Users/me/projects/app": { "name": "The App", "asks": [ { "title": "…", "text": "…" } ], "hidden": false }
//     }
//   }
//
// Anything malformed is ignored field by field: a bad entry never hides the rest of your setup.

import { readFileSync, watch, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MAX_ASKS = 12;

const cleanAsk = (a) => {
  if (!a || typeof a !== 'object') return null;
  const text = String(a.text ?? '').trim().slice(0, 4000);
  if (!text) return null;
  return { title: String(a.title ?? text).trim().slice(0, 60) || text.slice(0, 60), text };
};
const cleanAsks = (list) => (Array.isArray(list) ? list.map(cleanAsk).filter(Boolean).slice(0, MAX_ASKS) : []);

export function parseCustomize(raw) {
  let o = {};
  try { o = JSON.parse(raw); } catch { return { asks: [], projects: {} }; }
  if (!o || typeof o !== 'object') return { asks: [], projects: {} };
  const projects = {};
  if (o.projects && typeof o.projects === 'object') {
    for (const [path, p] of Object.entries(o.projects)) {
      if (!path.startsWith('/') || !p || typeof p !== 'object') continue;
      const name = String(p.name ?? '').trim().slice(0, 80);
      projects[path.replace(/\/+$/, '')] = { ...(name ? { name } : {}), asks: cleanAsks(p.asks), hidden: p.hidden === true };
    }
  }
  return { asks: cleanAsks(o.asks), projects };
}

export function makeCustomize({ file = join(homedir(), '.walkie', 'walkie.json'), onChange = () => {}, log = () => {} } = {}) {
  let current = { asks: [], projects: {} };
  let mtime = 0;
  const load = () => {
    try { current = parseCustomize(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log(`[customize] ${e.message}`); current = { asks: [], projects: {} }; }
  };
  load();
  // Agents edit the file; the phone hears about it within a second.
  let timer = null; let watcher = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    watcher = watch(dirname(file), (_e, name) => {
      if (name && name !== 'walkie.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => { load(); onChange(current); }, 400);
      timer.unref?.();
    });
    watcher.unref?.();
  } catch (e) { log(`[customize] not watching: ${e.message}`); }

  return {
    file,
    get: () => current,
    /// Quick asks for a folder: the project's own, then the global ones.
    asks(cwd) {
      const p = cwd ? current.projects[String(cwd).replace(/\/+$/, '')] : null;
      return [...(p?.asks || []), ...current.asks].slice(0, MAX_ASKS);
    },
    project(path) { return current.projects[String(path || '').replace(/\/+$/, '')] || null; },
    exists: () => existsSync(file),
    close() { clearTimeout(timer); watcher?.close(); },
  };
}
