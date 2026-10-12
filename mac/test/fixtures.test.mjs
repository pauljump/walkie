// Replays what agents really streamed (test/fixtures/<agent>/*.json, made by scripts/record-fixture.mjs)
// through Walkie's own mappers, and compares the events the phone would get with a saved snapshot.
// An agent update that changes its output fails here with the exact difference.
// After re-recording on purpose: UPDATE_FIXTURES=1 npm test, then read the snapshot diff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/hub.mjs';
import { makeClaude } from '../src/claude.mjs';
import { makeCodex } from '../src/codex.mjs';

process.env.HOME = mkdtempSync(join(tmpdir(), 'walkie-test-home-'));

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (agent, file) => JSON.parse(readFileSync(join(dir, agent, file), 'utf8'));
const names = (agent) => (existsSync(join(dir, agent)) ? readdirSync(join(dir, agent)).filter((f) => f.endsWith('.stream.json')).map((f) => f.replace('.stream.json', '')) : []);
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };

// What the phone sees, minus things that differ every run: random ids become e1, e2… in order of
// first appearance, and timestamps go.
function stable(events) {
  const ids = new Map();
  const idOf = (v) => { if (!ids.has(v)) ids.set(v, `e${ids.size + 1}`); return ids.get(v); };
  // Through JSON, because that's what the phone receives (an undefined field simply isn't there).
  return JSON.parse(JSON.stringify(events.map(({ ts, ...e }) => ({ ...e, id: idOf(e.id), ...(e.ask ? { ask: idOf(e.ask) } : {}) }))));
}

function snapshot(agent, name, kind, events) {
  const file = join(dir, agent, `${name}.${kind}.expected.json`);
  const got = stable(events);
  if (process.env.UPDATE_FIXTURES || !existsSync(file)) { writeFileSync(file, `${JSON.stringify(got, null, 1)}\n`); return; }
  assert.deepEqual(got, JSON.parse(readFileSync(file, 'utf8')), `${agent}/${name} ${kind} events changed; if the agent changed on purpose, re-record and UPDATE_FIXTURES=1`);
}

for (const name of names('claude')) {
  test(`fixture claude/${name}: the live stream maps to the same events`, async () => {
    const stream = read('claude', `${name}.stream.json`);
    const hub = new Hub();
    const replay = () => {
      const gen = (async function* () { for (const m of stream) yield m; })();
      gen.interrupt = async () => {}; gen.supportedCommands = async () => [];
      return gen;
    };
    const claude = makeClaude({ hub, query: replay, listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} } });
    const s = claude.start({ cwd: '/tmp/fixture', text: 'Run the scripted task' });
    await until(() => s.events.some((e) => e.kind === 'result'));
    snapshot('claude', name, 'stream', s.events);
  });

  test(`fixture claude/${name}: the saved transcript maps to the same events`, async () => {
    const history = read('claude', `${name}.history.json`);
    const claude = makeClaude({ hub: new Hub(), query: () => { throw new Error('no'); }, listSessions: async () => [], getSessionMessages: async () => history, running: { get: async () => new Map(), watch: () => () => {} } });
    snapshot('claude', name, 'history', await claude.history('fixture'));
  });
}

// Codex: a fake app-server that answers Walkie's requests with the recorded responses and then plays
// the recorded notifications.
function replaySpawn(log) {
  return () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    const out = (m) => proc.stdout.write(`${JSON.stringify(m)}\n`);
    const response = (method) => log.find((e) => e.response === method)?.result ?? {};
    let buf = '';
    proc.stdin.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.id == null) continue;
        out({ id: msg.id, result: response(msg.method) });
        if (msg.method === 'turn/start') for (const e of log) if (e.method && e.method !== 'thread/started') out({ method: e.method, params: e.params });
      }
    });
    return proc;
  };
}

for (const name of names('codex')) {
  test(`fixture codex/${name}: the live stream maps to the same events`, async () => {
    const log = read('codex', `${name}.stream.json`);
    const hub = new Hub();
    const codex = makeCodex({ hub, spawn: replaySpawn(log), codexHome: mkdtempSync(join(tmpdir(), 'wk-codex-')) });
    const s = await codex.start({ cwd: '/tmp/fixture', text: 'Run the scripted task' });
    await until(() => s.status === 'idle' && s.events.some((e) => e.kind === 'result' || e.kind === 'error'));
    await new Promise((r) => setTimeout(r, 50));
    snapshot('codex', name, 'stream', s.events);
  });
}
