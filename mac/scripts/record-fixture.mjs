#!/usr/bin/env node
// Record what an agent actually streams, so tests can replay it through Walkie's mappers and catch an
// agent update that changes its output (research/fundamentals/transcript-normalization.md).
//
//   node scripts/record-fixture.mjs claude [name]   one short scripted Claude session (smallest model)
//   node scripts/record-fixture.mjs codex  [name]   the same for Codex
//   node scripts/record-fixture.mjs claude voice     a multi-part question answered in the Walkie voice
//
// Each run uses a little of that agent's quota. It works in a throwaway folder, so no real
// conversation ends up in the repo; paths are rewritten to /tmp/fixture and thinking signatures dropped.
// Then run `UPDATE_FIXTURES=1 npm test` to refresh the expected events, and read the diff.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installStyle, STYLE_NAME } from '../src/claude.mjs';

const [agent, name = 'tools'] = process.argv.slice(2);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', agent || '');

const TASK = `Work only in the current folder. Keep every reply to one short sentence.
1. Read notes.txt.
2. Run: ls
3. Run: cat missing.txt (it will fail, that's expected).
4. In notes.txt change the word blue to green.
5. Create done.txt containing: ok
6. Make a short todo list of the steps you did, all marked completed.
Then say "Finished."`;

// Four separate points and no tools: shows whether the Walkie voice answers as separate short messages.
const VOICE_TASK = `Quick gut check on four things for a phone app I'm building: should it use SwiftUI or React Native, should the Mac bridge run under launchd or PM2, should offline messages queue on the phone, and is Tailscale fine for remote access? Don't look at any files.`;

function workdir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wk-fixture-')));
  writeFileSync(join(dir, 'notes.txt'), 'The sky is blue.\nThe sea is blue too.\n');
  return dir;
}

// Paths and secrets out; everything else exactly as the agent sent it.
function scrub(value, dir) {
  const text = JSON.stringify(value)
    .split(dir).join('/tmp/fixture')
    .split(homedir()).join('/Users/you');
  return JSON.parse(text, (k, v) => (k === 'signature' || k === 'encrypted_content' ? '' : v));
}

// The session-start message lists your skills, MCP servers and plugins; keep only what Walkie reads.
function trimInit(m) {
  if (m.type !== 'system' || m.subtype !== 'init') return m;
  const { type, subtype, model, session_id, uuid, cwd, permissionMode, claude_code_version } = m;
  return { type, subtype, model, session_id, uuid, cwd, permissionMode, claude_code_version, slash_commands: ['review'] };
}

function save(file, data) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), `${JSON.stringify(data, null, 1)}\n`);
  console.log(`wrote test/fixtures/${agent}/${file} (${data.length} entries)`);
}

async function recordClaude() {
  const dir = workdir();
  const stream = [];
  const voice = name === 'voice';
  if (voice) installStyle();
  const q = query({
    prompt: voice ? VOICE_TASK : TASK,
    options: { cwd: dir, model: 'haiku', systemPrompt: { type: 'preset', preset: 'claude_code' }, includePartialMessages: true, ...(voice ? { settings: { outputStyle: STYLE_NAME } } : {}), canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }) },
  });
  let sessionId = null;
  for await (const m of q) {
    sessionId ||= m.session_id;
    stream.push(m);
    if (m.type === 'result') console.log(`result: ${m.subtype}, $${(m.total_cost_usd || 0).toFixed(4)}`);
  }
  save(`${name}.stream.json`, scrub(stream.map(trimInit), dir));
  save(`${name}.history.json`, scrub(await getSessionMessages(sessionId, { dir }), dir));
}

async function recordCodex() {
  const dir = workdir();
  const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout });
  let id = 0; const calls = new Map(); const log = [];
  let finished; const done = new Promise((r) => (finished = r));
  lines.on('line', (l) => {
    if (!l.trim()) return;
    const m = JSON.parse(l);
    if (m.id != null && !m.method) { log.push({ response: calls.get(m.id)?.method, result: m.result, error: m.error }); calls.get(m.id)?.resolve(m.result); return; }
    if (m.id != null && m.method) { proc.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: 'accept' } })}\n`); log.push({ request: m.method, params: m.params }); return; }
    log.push({ method: m.method, params: m.params });
    if (m.method === 'turn/completed') finished();
  });
  const call = (method, params) => new Promise((resolve) => { const i = ++id; calls.set(i, { method, resolve }); proc.stdin.write(`${JSON.stringify({ id: i, method, params })}\n`); });
  await call('initialize', { clientInfo: { name: 'walkie-fixture', version: '0' } });
  proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const t = await call('thread/start', { cwd: dir, approvalPolicy: 'never', sandbox: 'workspace-write' });
  await call('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: TASK }] });
  await done;
  const history = await call('thread/read', { threadId: t.thread.id, includeTurns: true });
  proc.kill();
  save(`${name}.stream.json`, scrub(log.filter((e) => !/^(mcpServer|account|remoteControl)\//.test(e.method || '')), dir));
  save(`${name}.history.json`, scrub([history], dir));
}

if (agent === 'claude') await recordClaude();
else if (agent === 'codex') await recordCodex();
else { console.log('usage: record-fixture.mjs claude|codex [name]'); process.exit(1); }
process.exit(0);
