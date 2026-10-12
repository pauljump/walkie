import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Hub } from '../src/hub.mjs';
import { makeClaude, claudeMessageEvents } from '../src/claude.mjs';
import { makeCodex, codexItemEvent } from '../src/codex.mjs';
import { makeServer } from '../src/server.mjs';

// Never touch the real ~/.walkie or ~/.claude/sessions from a test.
process.env.HOME = mkdtempSync(join(tmpdir(), 'walkie-test-home-'));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await tick(); }
  throw new Error('timed out');
}

test('hub: events upsert by id, asks block until answered', async () => {
  const hub = new Hub();
  const s = hub.open({ agent: 'claude', id: 'a', cwd: '/tmp' });
  s.push({ id: 't1', kind: 'tool', status: 'running', title: 'x' });
  s.push({ id: 't1', kind: 'tool', status: 'ok', title: 'x' });
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].status, 'ok');

  const p = s.ask({ type: 'permission', title: '$ rm', options: [] });
  assert.equal(s.status, 'waiting');
  const ask = s.events.find((e) => e.kind === 'ask');
  assert.equal(s.answer(ask.id, { choice: 'allow' }), true);
  assert.deepEqual(await p, { choice: 'allow' });
  assert.equal(s.answer(ask.id, { choice: 'allow' }), false, 'an ask resolves once');
  assert.ok(s.events.some((e) => e.kind === 'resolved' && e.ask === ask.id));
});

test('claude: message normalization', () => {
  const evs = claudeMessageEvents({ type: 'assistant', message: { id: 'm1', content: [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/Users/x/a.js', old_string: 'a', new_string: 'b' } },
  ] } });
  assert.equal(evs[0].kind, 'text');
  assert.equal(evs[1].title, 'Edit ~/a.js');
  assert.match(evs[1].diff, /-a\n\+b/);
  const res = claudeMessageEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] } });
  assert.equal(res[0].patch, true);
  assert.equal(res[0].output, 'done');
  assert.equal(claudeMessageEvents({ type: 'user', uuid: 'u', message: { content: '<command-name>/clear</command-name>' } }).length, 0);
});

// A fake Agent SDK query: reads the prompt stream and scripts a turn that asks for permission.
function fakeQuery(calls) {
  return ({ prompt, options }) => {
    calls.push(options);
    let interrupted = false;
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', slash_commands: ['review'], model: 'm' };
      for await (const input of prompt) {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Work' } }, parent_tool_use_id: null };
        yield { type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: null };
        const decision = await options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [{ type: 'addRules' }] });
        yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: decision.behavior === 'allow' ? 'a.txt' : 'denied', is_error: decision.behavior !== 'allow' }] }, parent_tool_use_id: null };
        yield { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: `You said: ${input.message.content}` }] }, parent_tool_use_id: null };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5 };
      }
    })();
    gen.interrupt = async () => { interrupted = true; };
    gen.supportedCommands = async () => [{ name: 'review', description: 'Review' }];
    gen.wasInterrupted = () => interrupted;
    return gen;
  };
}

test('claude: a phone turn streams, asks, and completes', async () => {
  const hub = new Hub();
  const calls = [];
  const claude = makeClaude({ hub, query: fakeQuery(calls), listSessions: async () => [], getSessionMessages: async () => [] });
  const s = claude.start({ cwd: '/tmp', text: 'list files', mode: 'auto' });
  assert.equal(calls[0].permissionMode, 'acceptEdits');
  assert.match(calls[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].systemPrompt.preset, 'claude_code');
  const ask = await until(() => s.events.find((e) => e.kind === 'ask'));
  assert.equal(ask.title, '$ ls');
  assert.deepEqual(ask.options.map((o) => o.id), ['allow', 'always', 'deny']);
  s.answer(ask.id, { choice: 'allow' });
  await until(() => s.events.some((e) => e.kind === 'result'));
  assert.deepEqual(s.events.filter((e) => e.kind !== 'resolved').map((e) => e.kind), ['user', 'tool', 'ask', 'text', 'result']);
  assert.equal(s.events.find((e) => e.kind === 'tool').status, 'ok');
  assert.equal(s.events.find((e) => e.kind === 'text').text, 'You said: list files');
  assert.equal(s.draft, '');
  assert.equal(s.status, 'idle');
  assert.deepEqual((await claude.commands(s)).map((c) => c.name), ['review']);
});

test('codex: item normalization', () => {
  assert.equal(codexItemEvent({ type: 'commandExecution', id: 'c', command: 'ls', exitCode: 1, status: 'completed' }).status, 'error');
  assert.equal(codexItemEvent({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: '/Users/x/p/a.js', diff: '+x', kind: { type: 'update' } }] }).title, 'Edit a.js');
  assert.equal(codexItemEvent({ type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'npm test'", status: 'completed' }).title, '$ npm test');
  assert.equal(codexItemEvent({ type: 'agentMessage', id: 'm', text: 'x' }, { done: false }), null);
});

// A fake `codex app-server`: answers JSON-RPC on stdio and scripts one turn with an approval.
function fakeCodexSpawn(seen) {
  return () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    const out = (m) => proc.stdout.write(`${JSON.stringify(m)}\n`);
    let buf = '';
    proc.stdin.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        seen.push(msg);
        if (msg.method === 'initialize') out({ id: msg.id, result: {} });
        else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: 'th1', turns: [] } } });
        else if (msg.method === 'thread/list') out({ id: msg.id, result: { data: [{ id: 'th0', cwd: '/tmp', preview: 'old', updatedAt: 1700000000 }] } });
        else if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(msg.method)) out({ id: msg.id, result: {} });
        else if (msg.method === 'turn/start') {
          out({ id: msg.id, result: { turn: { id: 'turn1', items: [], status: 'inProgress' } } });
          out({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'turn1' } } });
          out({ method: 'item/started', params: { threadId: 'th1', turnId: 'turn1', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: msg.params.input[0].text }] } } });
          out({ method: 'item/agentMessage/delta', params: { threadId: 'th1', turnId: 'turn1', itemId: 'm1', delta: 'Hel' } });
          out({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'th1', turnId: 'turn1', itemId: 'c1', command: 'npm test', reason: 'run tests' } });
        } else if (msg.id === 900) {
          out({ method: 'item/completed', params: { threadId: 'th1', turnId: 'turn1', item: { type: 'agentMessage', id: 'm1', text: 'Hello' } } });
          out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'turn1', status: 'completed', items: [] } } });
        }
      }
    });
    return proc;
  };
}

test('codex: start, approval round-trip, completion, list', async () => {
  const hub = new Hub();
  const seen = [];
  const codex = makeCodex({ hub, spawn: fakeCodexSpawn(seen) });
  const s = await codex.start({ cwd: '/tmp', text: 'run tests', mode: 'auto' });
  assert.equal(s.key, 'codex:th1');
  assert.deepEqual(seen.find((m) => m.method === 'thread/start').params, { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.equal(seen.filter((m) => m.method === 'initialized').length, 1);
  const ask = await until(() => s.events.find((e) => e.kind === 'ask'));
  assert.equal(ask.title, '$ npm test');
  assert.equal(s.draft, 'Hel');
  s.answer(ask.id, { choice: 'acceptForSession' });
  await until(() => s.events.some((e) => e.kind === 'result'));
  assert.deepEqual(seen.find((m) => m.id === 900).result, { decision: 'acceptForSession' });
  assert.equal(s.events.find((e) => e.kind === 'text').text, 'Hello');
  assert.equal(s.status, 'idle');
  const list = await codex.list({ cwd: '/tmp' });
  assert.equal(list[0].updatedAt, 1700000000000);
  codex.stop();
});

test('server: auth, projects, sessions, send + answer over HTTP, frames over WS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'walkie-roots-'));
  mkdirSync(join(root, 'app', '.git'), { recursive: true });
  const hub = new Hub();
  const claude = makeClaude({ hub, query: fakeQuery([]), listSessions: async () => [{ sessionId: 'old', summary: 'Desk session', lastModified: 5, cwd: join(root, 'app') }], getSessionMessages: async () => [] });
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k', projectRoots: [root] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    const projects = (await api('/api/projects')).json.projects;
    assert.equal(projects[0].name, 'app');

    const frames = [];
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?key=k`);
    ws.on('message', (d) => frames.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));

    const started = await api('/api/session', { agent: 'claude', cwd: join(root, 'app'), text: 'hi', clientId: 'c1' });
    assert.equal(started.status, 200);
    const key = started.json.session.key;
    assert.equal((await api('/api/session', { agent: 'claude', cwd: join(root, 'app'), text: 'hi', clientId: 'c1' })).json.duplicate, true);

    const ask = await until(() => frames.find((f) => f.type === 'event' && f.event.kind === 'ask'));
    assert.equal((await api('/api/session/answer', { key, askId: ask.event.id, choice: 'deny' })).status, 200);
    await until(() => frames.find((f) => f.type === 'event' && f.event.kind === 'result'));
    const sessions = (await api(`/api/sessions?cwd=${encodeURIComponent(join(root, 'app'))}`)).json.sessions;
    assert.deepEqual(sessions.map((s) => s.live), [true, false]);
    const one = (await api(`/api/session?key=${encodeURIComponent(key)}`)).json;
    assert.equal(one.events.find((e) => e.kind === 'tool').status, 'error', 'denied tool shows as error');
    ws.close();
  } finally {
    server.close();
  }
});

test('push: JWT shape, what buzzes, quiet while foreground, stale tokens dropped', async () => {
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { makePush, apnsJwt, notificationFor } = await import('../src/push.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = apnsJwt({ keyId: 'K1', teamId: 'T1', key, now: 1 });
  const [h, b, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'K1' });
  assert.ok(createVerify('SHA256').update(`${h}.${b}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

  const s = { agent: 'codex', cwd: '/x/app', key: 'codex:1', title: 'Fix tests' };
  assert.match(notificationFor(s, { kind: 'ask', title: '$ rm -rf build' }).body, /rm -rf build/);
  assert.equal(notificationFor(s, { kind: 'result', ok: true }, { turnMs: 5000 }), null, 'short turns do not buzz');
  assert.equal(notificationFor(s, { kind: 'result', ok: true }, { turnMs: 60000 }).title, 'Codex finished · app');

  const hub = new Hub();
  const sent = [];
  let fg = true;
  const dir = mkdtempSync(join(tmpdir(), 'walkie-push-'));
  const push = makePush({ hub, isForeground: () => fg, config: { keyId: 'K1', teamId: 'T1', key }, devicesPath: join(dir, 'd.json'), send: async (d, p) => { sent.push(p); return { status: d.token.startsWith('dead') ? 410 : 200, body: '' }; } });
  push.register({ token: 'ab'.repeat(32), env: 'production' });
  push.register({ token: 'dead'.repeat(16), env: 'production' });
  const session = hub.open({ agent: 'claude', id: 'p', cwd: '/x/app' });
  session.ask({ type: 'permission', title: '$ ls', options: [] });
  await tick(20);
  assert.equal(sent.length, 0, 'no push while the app is open');
  fg = false;
  session.ask({ type: 'permission', title: '$ pwd', options: [] });
  await tick(20);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].key, 'claude:p');
  assert.equal(JSON.parse(readFileSync(join(dir, 'd.json'), 'utf8')).devices.length, 1, 'a 410 token is dropped');
  assert.throws(() => push.register({ token: 'nope' }));
});

test('usage: provider meters normalize to one shape', async () => {
  const { claudeWindows, codexWindows, stateOf, makeUsage } = await import('../src/usage.mjs');
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 17, resets_at: '2026-09-23T20:00:00Z' }, seven_day: { utilization: 81, resets_at: null }, seven_day_opus: null }).map((w) => [w.name, w.usedPct]), [['5 hours', 17], ['Week', 81]]);
  assert.deepEqual(codexWindows({ primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790412298 } }), [{ name: 'Week', usedPct: 100, resetsAt: 1790412298000 }]);
  assert.equal(stateOf([{ usedPct: 17 }, { usedPct: 81 }]), 'warning');
  assert.equal(stateOf([{ usedPct: 100 }]), 'full');

  const hub = new Hub();
  const fakeQuery = () => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 17, resets_at: null } } }), close() {} });
  const u = makeUsage({ hub, query: fakeQuery, codexCall: async () => ({ ordinaryUsageAllowed: false, rateLimits: { planType: 'prolite', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1 } } }) });
  const { providers } = await u.all();
  const by = Object.fromEntries(providers.map((p) => [p.id, p]));
  assert.equal(by.claude.state, 'ok');
  assert.equal(by.claude.plan, 'pro');
  assert.equal(by.codex.state, 'full');
  assert.ok(['unmetered', 'signed-out'].includes(by.agy.state));
});

// A fake ACP agent: answers initialize/session/new/session/prompt and asks for permission once.
function fakeAcpSpawn(seen) {
  return () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    const out = (m) => proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    let buf = ''; let promptId = null;
    proc.stdin.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); seen.push(m);
        if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1 } });
        else if (m.method === 'session/new') {
          out({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compress' }] } } });
          out({ id: m.id, result: { sessionId: 's1' } });
        } else if (m.method === 'session/prompt') {
          promptId = m.id;
          out({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing it.' } } } });
          out({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending', locations: [{ path: '/x/a.txt' }], rawInput: { file_path: '/x/a.txt' } } } });
          out({ id: 700, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', kind: 'edit', locations: [{ path: '/x/a.txt' }], content: [{ type: 'diff', path: '/x/a.txt', oldText: '', newText: 'hi' }] }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } });
        } else if (m.id === 700) {
          out({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: '/x/a.txt', oldText: '', newText: 'hi' }] } } });
          out({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
          out({ id: promptId, result: { stopReason: 'end_turn' } });
        }
      }
    });
    return proc;
  };
}

test('acp: prompt streams text + tools, permission becomes an ask, turn ends with a result', async () => {
  const { makeAcp } = await import('../src/acp.mjs');
  const hub = new Hub(); const seen = [];
  const grok = makeAcp({ hub, agent: 'grok', label: 'Grok', command: ['grok', 'agent', 'stdio'], spawn: fakeAcpSpawn(seen) });
  const s = await grok.start({ cwd: '/x', text: 'make a.txt' });
  assert.equal(s.key, 'grok:s1');
  const ask = await until(() => s.events.find((e) => e.kind === 'ask'));
  assert.equal(ask.title, 'Edit /x/a.txt');
  assert.match(ask.diff, /\+hi/);
  assert.deepEqual(ask.options.map((o) => o.style), [undefined, 'destructive']);
  s.answer(ask.id, { choice: 'allow-once' });
  await until(() => s.events.some((e) => e.kind === 'result'));
  assert.deepEqual(seen.find((m) => m.id === 700).result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  assert.deepEqual(s.events.filter((e) => e.kind === 'text').map((e) => e.text), ['Writing it.', 'Done.']);
  assert.equal(s.events.find((e) => e.kind === 'tool').status, 'ok');
  assert.equal(s.status, 'idle');
  assert.deepEqual((await grok.commands()).map((c) => c.name), ['compact']);
  grok.stop();
});

test('agy: one process per turn, conversation id from init, denied actions explained', async () => {
  const { makeAgy } = await import('../src/agy.mjs');
  const hub = new Hub(); const calls = [];
  const lines = (conv) => [
    { event: 'init', conversation_id: conv },
    { event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'On it' } },
    { event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '.' } },
    { event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' }, error: { message: 'permission check failed' } } } },
    { event: 'result', result: { status: 'SUCCESS', duration_seconds: 1.5, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } },
  ];
  const spawn = (cmd, args) => {
    calls.push(args);
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => { for (const l of lines('c1')) proc.stdout.write(`${JSON.stringify(l)}\n`); proc.stdout.end(); setTimeout(() => proc.emit('close', 0), 20); });
    return proc;
  };
  const dir = mkdtempSync(join(tmpdir(), 'walkie-agy-'));
  const agy = makeAgy({ hub, spawn, journalDir: dir });
  const s = await agy.start({ cwd: '/x', text: 'hello', mode: 'auto' });
  assert.equal(s.key, 'agy:c1');
  assert.ok(calls[0].includes('--sandbox') && calls[0].includes('--dangerously-skip-permissions'));
  await until(() => s.events.some((e) => e.kind === 'result'));
  await until(() => s.status === 'idle');
  assert.equal(s.events.find((e) => e.kind === 'text').text, 'On it.');
  assert.equal(s.events.find((e) => e.kind === 'tool').title, '$ pwd');
  assert.match(s.events.find((e) => e.kind === 'result').text, /blocked from: RunCommand/);
  await agy.send(s, 'again');
  assert.deepEqual(calls[1].slice(calls[1].indexOf('--conversation'), calls[1].indexOf('--conversation') + 2), ['--conversation', 'c1']);
  await until(() => s.status === 'idle');
  const listed = await agy.list({ cwd: '/x' });
  assert.equal(listed[0].id, 'c1');
  assert.ok((await agy.history('c1')).some((e) => e.kind === 'user' && e.text === 'hello'));
});

test('models: parsers and families', async () => {
  const { parseAgyModels, parseGrokModels, family } = await import('../src/models.mjs');
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n').map((m) => m.id), ['gemini-3.1-pro-high', 'claude-opus-4-6-thinking']);
  const g = parseGrokModels('Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n');
  assert.deepEqual(g.map((m) => [m.id, m.isDefault]), [['grok-4.7', true], ['grok-4.6', false]]);
  assert.equal(family('claude-opus-4-6-thinking'), 'Claude Opus');
  assert.equal(family('gpt-6-astra'), 'GPT');
  assert.equal(family('gemini-3.8-flash-high'), 'Gemini Flash');
});

test('effort: Antigravity variants fold into one model', async () => {
  const { foldAgyEfforts } = await import('../src/models.mjs');
  const rows = foldAgyEfforts([
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }, { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
  assert.deepEqual(rows[0], { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', effortIds: { high: 'gemini-3.8-flash-high', medium: 'gemini-3.8-flash-medium', low: 'gemini-3.8-flash-low' } });
  assert.deepEqual(rows[1], { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' });
});

test('sync: which Claude sessions are running comes from `claude agents --json`', async () => {
  const { writeFileSync } = await import('node:fs');
  const reg = mkdtempSync(join(tmpdir(), 'wk-reg-'));
  writeFileSync(join(reg, '1.json'), JSON.stringify({ pid: 1, sessionId: 'on', bridgeSessionId: 'cse_x' }));
  writeFileSync(join(reg, '3.json'), 'not json');
  const { makeRunningClaude, registryHints } = await import('../src/claude.mjs');
  let fail = false; const execCalls = [];
  const rc = makeRunningClaude({ claudePath: 'claude', hints: () => registryHints(reg), exec: async (cmd, args) => { execCalls.push(args.join(' ')); if (fail) throw new Error('boom'); return JSON.stringify([{ sessionId: 'on', status: 'idle' }, { sessionId: 'two', status: 'busy' }]); } });
  const now = await rc.get();
  assert.deepEqual(execCalls, ['agents --json']);
  assert.deepEqual([...now.entries()], [['on', { status: 'idle', remote: true }], ['two', { status: 'busy', remote: false }]]);
  fail = true;
  assert.equal((await rc.get({ fresh: true })).size, 2); // a failed check keeps the last good answer
});

test('sync: Claude rename and archive go to Claude itself', async () => {
  const hub = new Hub(); const calls = [];
  const old = Date.now() - 5 * 3600 * 1000;
  let rows = [
    { sessionId: 'on', summary: 'Running one', lastModified: old, cwd: '/p' },
    { sessionId: 'off', summary: 'Stopped one', lastModified: old, cwd: '/p' },
    { sessionId: 'gone', summary: 'Archived', lastModified: old, cwd: '/p', tag: 'archived' },
  ];
  const running = new Map([['on', { remote: true }]]);
  const claude = makeClaude({
    hub, query: fakeQuery([]), getSessionMessages: async () => [],
    listSessions: async () => rows,
    running: { get: async () => running, watch: () => () => {} },
    renameSession: async (id, title) => { calls.push(['rename', id, title]); rows = rows.map((r) => r.sessionId === id ? { ...r, customTitle: title } : r); },
    tagSession: async (id, tag) => { calls.push(['tag', id, tag]); rows = rows.map((r) => r.sessionId === id ? { ...r, tag } : r); },
  });
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-api-key': 'k', 'content-type': 'application/json', 'x-walkie-agents': 'claude' };
  const list = async () => (await (await fetch(`${base}/api/sessions`, { headers: h })).json()).sessions;

  let s = await list();
  assert.deepEqual(s.map((x) => x.id).sort(), ['off', 'on']);
  assert.equal(s.find((x) => x.id === 'on').open, true);
  assert.equal(s.find((x) => x.id === 'on').remote, true);
  assert.equal(s.find((x) => x.id === 'off').open, false);

  let r = await fetch(`${base}/api/session/rename`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'claude:off', title: 'Better name' }) });
  assert.equal((await r.json()).where, 'claude');
  r = await fetch(`${base}/api/session/archive`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'claude:on' }) });
  assert.equal((await r.json()).where, 'claude');
  assert.deepEqual(calls, [['rename', 'off', 'Better name'], ['tag', 'on', 'archived']]);
  s = await list();
  assert.deepEqual(s.map((x) => [x.id, x.title]), [['off', 'Better name']]);

  await fetch(`${base}/api/session/archive`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'claude:on', archived: false }) });
  assert.deepEqual(calls.at(-1), ['tag', 'on', null]);
  server.close();
});

test('sync: a session seen to stop drops out of open right away; providers without rename use the overlay', async () => {
  const hub = new Hub();
  const recent = Date.now() - 60_000;
  let runningIds = ['a', 'b']; let cue = null;
  const claude = { agent: 'claude', list: async () => [{ agent: 'claude', id: 'a', cwd: '/p', title: 'A', updatedAt: recent }, { agent: 'claude', id: 'b', cwd: '/p', title: 'B', updatedAt: recent }], runningIds: async () => runningIds, watchRunning: (fn) => { cue = fn; return () => {}; }, history: async () => [] };
  const codex = { agent: 'codex', list: async () => [{ agent: 'codex', id: 'c', cwd: '/p', title: 'C', updatedAt: recent }], history: async () => [] };
  const server = makeServer({ hub, adapters: { claude, codex }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-api-key': 'k', 'content-type': 'application/json', 'x-walkie-agents': 'claude,codex' };
  const list = async () => Object.fromEntries((await (await fetch(`${base}/api/sessions`, { headers: h })).json()).sessions.map((x) => [x.id, x]));

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?key=k`);
  const frames = []; ws.on('message', (m) => frames.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  await tick(50);
  runningIds = ['b']; // 'a' was closed somewhere else
  cue();
  await until(() => frames.some((f) => f.type === 'sessions'));
  const s = await list();
  assert.equal(s.a.open, false);
  assert.equal(s.b.open, true);
  assert.equal(s.c.open, true); // no running signal for Codex yet: recent counts as open

  const r = await fetch(`${base}/api/session/rename`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'codex:c', title: 'Named here' }) });
  assert.equal((await r.json()).where, 'walkie');
  assert.equal((await list()).c.title, 'Named here');
  await fetch(`${base}/api/session/archive`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'codex:c' }) });
  assert.equal((await list()).c, undefined);
  ws.close(); server.close();
});

test('sync: Codex rename and archive go through its own server', async () => {
  const hub = new Hub(); const seen = [];
  const codex = makeCodex({ hub, spawn: fakeCodexSpawn(seen), codexHome: mkdtempSync(join(tmpdir(), 'wk-codex-')) });
  await codex.rename('th0', 'Named');
  await codex.archive('th0', true);
  await codex.archive('th0', false);
  assert.deepEqual(seen.filter((m) => m.method?.startsWith('thread/') && m.method !== 'thread/list').map((m) => [m.method, m.params]), [
    ['thread/name/set', { threadId: 'th0', name: 'Named' }], ['thread/archive', { threadId: 'th0' }], ['thread/unarchive', { threadId: 'th0' }],
  ]);
  const stop = codex.watchChanges(() => {}); stop();
});

test('sync: renaming a session Walkie is running goes to the session itself', async () => {
  const hub = new Hub(); const calls = [];
  const q = fakeQuery([]);
  const liveQuery = (args) => { const it = q(args); it.renameSession = async (title) => { calls.push(['live', title]); }; return it; };
  const claude = makeClaude({ hub, query: liveQuery, listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} }, renameSession: async (id, title) => { calls.push(['file', id, title]); } });
  const s = claude.start({ cwd: '/tmp', text: 'hi' });
  await claude.rename(s.id, 'Live name');
  await claude.rename('someone-else', 'File name');
  assert.deepEqual(calls, [['live', 'Live name'], ['file', 'someone-else', 'File name']]);
  assert.equal(s.title, 'Live name');
});

test('delivery: a failed send can be retried with the same clientId; a repeat is recognized', async () => {
  const hub = new Hub(); let fail = true; const sent = [];
  const claude = { agent: 'claude', list: async () => [], history: async () => [], commands: async () => [],
    send: async (s, text) => { if (fail) { fail = false; throw new Error('agent busy'); } sent.push(text); s.push({ kind: 'user', text }); } };
  hub.open({ agent: 'claude', id: 'd1', cwd: '/tmp' });
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-api-key': 'k', 'content-type': 'application/json' };
  const post = (body) => fetch(`${base}/api/session/send`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const body = { key: 'claude:d1', text: 'hello', clientId: 'c-1' };
  assert.equal((await post(body)).status, 500);            // failed: not remembered
  assert.equal((await post(body)).status, 200);            // retry runs
  assert.deepEqual(await (await post(body)).json(), { duplicate: true }); // repeat doesn't
  assert.deepEqual(sent, ['hello']);
  const ev = hub.get('claude:d1').events.find((e) => e.kind === 'user');
  assert.equal(ev.clientId, 'c-1');
  server.close();
});

test('delivery: catch-up returns only events after the phone\'s seq, and a full log for another epoch', async () => {
  const hub = new Hub();
  const s = hub.open({ agent: 'claude', id: 'c1', cwd: '/tmp' });
  s.push({ id: 'a', kind: 'user', text: 'one' });
  s.push({ id: 'b', kind: 'tool', status: 'running', title: 't' });
  const mark = s.seq;
  s.push({ id: 'b', kind: 'tool', status: 'ok', title: 't' }); // replaced in place, still counts as new
  s.push({ id: 'c', kind: 'text', text: 'done' });
  const claude = { agent: 'claude', list: async () => [], history: async () => [] };
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (q) => (await fetch(`${base}/api/session?key=claude:c1&${q}`, { headers: { 'x-api-key': 'k' } })).json();
  let r = await get(`since=${mark}&epoch=${s.epoch}`);
  assert.equal(r.partial, true);
  assert.deepEqual(r.events.map((e) => [e.id, e.status || e.kind]), [['b', 'ok'], ['c', 'text']]);
  r = await get(`since=${mark}&epoch=other`);
  assert.equal(r.partial, undefined);
  assert.equal(r.events.length, 3);
  assert.equal(r.session.epoch, s.epoch);
  server.close();
});

test('protocol: an incompatible phone gets a clear 426', async () => {
  const hub = new Hub();
  const server = makeServer({ hub, adapters: { claude: { agent: 'claude', list: async () => [], history: async () => [] } }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(status.protocol, { min: 1, max: 1 });
  assert.ok(status.capabilities.includes('event-seq'));
  const ok = await fetch(`${base}/api/sessions`, { headers: { 'x-api-key': 'k', 'x-walkie-protocol': '1-2' } });
  assert.equal(ok.status, 200);
  const old = await fetch(`${base}/api/sessions`, { headers: { 'x-api-key': 'k', 'x-walkie-protocol': '0-0' } });
  assert.equal(old.status, 426);
  assert.equal((await old.json()).code, 'incompatible_protocol');
  server.close();
});

test('sync: a Claude session that stopped before the bridge started is not open, however recent', async () => {
  const hub = new Hub();
  const recent = Date.now() - 60_000;
  const claude = { agent: 'claude', sync: { running: 'native' }, list: async () => [{ agent: 'claude', id: 'gone', cwd: '/p', title: 'Vayo', updatedAt: recent }, { agent: 'claude', id: 'up', cwd: '/p', title: 'Up', updatedAt: recent, running: true }], runningIds: async () => ['up'], history: async () => [] };
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rows = (await (await fetch(`http://127.0.0.1:${server.address().port}/api/sessions`, { headers: { 'x-api-key': 'k', 'x-walkie-agents': 'claude' } })).json()).sessions;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.open])), { gone: false, up: true });
  server.close();
});

test('safety: Walkie won\'t start a second copy of a Claude session running in a terminal', async () => {
  const hub = new Hub(); const calls = [];
  const claude = makeClaude({ hub, query: (args) => { calls.push(args.options); return fakeQuery([])(args); }, listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map([['term', {}]]), watch: () => () => {} } });
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/session/send`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'claude:term', text: 'hi', clientId: 'x' }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /open in another app/);
  assert.equal(calls.length, 0);
  server.close();
});

test('titles: a session Walkie starts gets named after its first reply, once', async () => {
  const hub = new Hub(); const asked = [];
  const titled = (args) => { const it = fakeQuery([])(args); it.generateSessionTitle = async (d, o) => { asked.push([d, o]); return 'Say hello'; }; return it; };
  const claude = makeClaude({ hub, query: titled, listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} } });
  const s = claude.start({ cwd: '/tmp', text: 'hi there' });
  const ask = await until(() => s.events.find((e) => e.kind === 'ask'));
  s.answer(ask.id, { choice: ask.options[0].id });
  await until(() => s.title === 'Say hello');
  assert.equal(asked.length, 1);
  assert.match(asked[0][0], /hi there/);
  assert.deepEqual(asked[0][1], { persist: true });
});

test('codex: a response too big to hold fails only its own request, never the bridge', async () => {
  const { readLines } = await import('../src/codex.mjs');
  const stream = new PassThrough(); const lines = []; const dropped = [];
  readLines(stream, (l) => lines.push(l), (id, bytes) => dropped.push([id, bytes]), 100);
  stream.write('{"id":1,"result":{}}\n{"id":7,"result":"');
  stream.write('x'.repeat(150));
  stream.write('"}\n{"method":"a"}');
  stream.write('\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines, ['{"id":1,"result":{}}', '{"method":"a"}']);
  assert.equal(dropped[0][0], 7);
});

test('codex voice: spoken turns become messages marked voice; nothing breaks without the database', async () => {
  const { voiceEvents } = await import('../src/codex.mjs');
  const rows = [
    { item_id: 'a', created_at_ms: 1, item_json: JSON.stringify({ type: 'realtime_session_started' }) },
    { item_id: 'b', created_at_ms: 2, item_json: JSON.stringify({ type: 'transcript_segment', role: 'user', text: ' Can you hear me' }) },
    { item_id: 'c', created_at_ms: 3, item_json: JSON.stringify({ type: 'transcript_segment', role: 'assistant', text: 'Yes.' }) },
    { item_id: 'd', created_at_ms: 4, item_json: 'not json' },
    { item_id: 'e', created_at_ms: 5, item_json: JSON.stringify({ type: 'realtime_session_closed' }) },
  ];
  assert.deepEqual(voiceEvents(rows).map((e) => [e.kind, e.text, e.voice]), [['info', 'Voice chat started', true], ['user', 'Can you hear me', true], ['text', 'Yes.', true], ['info', 'Voice chat ended', true]]);
  const hub = new Hub(); const seen = [];
  const codex = makeCodex({ hub, spawn: fakeCodexSpawn(seen), codexHome: mkdtempSync(join(tmpdir(), 'wk-codex-')) });
  assert.deepEqual(await codex.voiceThreads(), []); // no database here: just no voice chats
});

test('archived: one list from each agent\'s own archive plus Walkie-only ones', async () => {
  const hub = new Hub();
  const claude = { agent: 'claude', archive: async () => {}, list: async ({ archived } = {}) => archived ? [{ agent: 'claude', id: 'ca', cwd: '/p', title: 'Tagged', updatedAt: 2 }] : [{ agent: 'claude', id: 'cb', cwd: '/p', title: 'Open', updatedAt: 3 }], history: async () => [] };
  const grok = { agent: 'grok', list: async () => [{ agent: 'grok', id: 'g1', cwd: '/p', title: 'Hidden in Walkie', updatedAt: 1 }], history: async () => [] };
  const server = makeServer({ hub, adapters: { claude, grok }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-api-key': 'k', 'content-type': 'application/json', 'x-walkie-agents': 'claude,grok' };
  await fetch(`${base}/api/session/archive`, { method: 'POST', headers: h, body: JSON.stringify({ key: 'grok:g1' }) });
  const rows = (await (await fetch(`${base}/api/sessions?archived=1`, { headers: h })).json()).sessions;
  assert.deepEqual(rows.map((r) => [r.key, r.archived]), [['claude:ca', true], ['grok:g1', true]]);
  server.close();
});

test('search: finds conversations by title, open or archived', async () => {
  const hub = new Hub();
  const claude = { agent: 'claude', archive: async () => {}, history: async () => [],
    list: async ({ archived } = {}) => archived ? [{ agent: 'claude', id: 'old', cwd: '/p', title: 'Pricing for teams (archived)', updatedAt: 1 }] : [{ agent: 'claude', id: 'new', cwd: '/p', title: 'Team pricing page', updatedAt: 2 }, { agent: 'claude', id: 'x', cwd: '/p', title: 'Something else', updatedAt: 3 }] };
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-api-key': 'k', 'x-walkie-agents': 'claude' };
  const r = await (await fetch(`${base}/api/search?q=pricing`, { headers: h })).json();
  assert.deepEqual(r.results.map((x) => [x.id, x.match]).sort(), [['new', 'title'], ['old', 'title']]);
  assert.deepEqual((await (await fetch(`${base}/api/search?q=a`, { headers: h })).json()).results, []);
  server.close();
});

test('attachments: an upload lands under ~/.walkie/uploads, comes back, and the limits hold', async () => {
  const { existsSync: exists, readFileSync: read } = await import('node:fs');
  const hub = new Hub();
  const server = makeServer({ hub, adapters: { claude: { agent: 'claude', list: async () => [], history: async () => [] } }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'image/png', 'x-walkie-filename': 'receipt.png', 'x-walkie-conversation': 'claude:abc' }, body: png });
  assert.equal(up.status, 200);
  const info = await up.json();
  assert.match(info.path, /\.walkie\/uploads\/claude:abc\/\d+-receipt\.png$/);
  assert.ok(exists(info.path));
  assert.deepEqual(read(info.path), png);
  const back = await fetch(`${base}/api/upload?path=${encodeURIComponent(info.path)}`, { headers: { 'x-api-key': 'k' } });
  assert.equal(back.headers.get('content-type'), 'image/png');
  const outside = await fetch(`${base}/api/upload?path=${encodeURIComponent('/etc/hosts')}`, { headers: { 'x-api-key': 'k' } });
  assert.equal(outside.status, 403);
  const exe = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/x-msdownload' }, body: png });
  assert.equal(exe.status, 415);
  const big = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) }, body: png, duplex: 'half' }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  const noKey = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(noKey.status, 401);
  server.close();
});

// ---- Reliability: what happens when a CLI is missing, hangs, or dies mid-turn.

// A spawn that fails the way a missing binary does (ENOENT on the next tick).
function missingSpawn() {
  return () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => {};
    setImmediate(() => { proc.stdin.destroy(); proc.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })); });
    return proc;
  };
}

test('reliability: a missing Codex fails with words you can act on, and the next call tries again', async () => {
  const hub = new Hub();
  let spawned = 0;
  const codex = makeCodex({ hub, spawn: (...a) => { spawned++; return missingSpawn()(...a); }, voiceQuery: async () => [] });
  await assert.rejects(codex.list(), /isn't installed/);
  await assert.rejects(codex.start({ cwd: '/tmp', text: 'hi' }), /isn't installed/);
  assert.equal(spawned, 2, 'each call after a failure starts a fresh app-server');
});

test('reliability: a Codex that never answers times out instead of hanging the list', async () => {
  const hub = new Hub();
  const silent = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    proc.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'initialize') proc.stdout.write(`${JSON.stringify({ id: m.id, result: {} })}\n`); } });
    return proc;
  };
  const codex = makeCodex({ hub, spawn: silent, quickMs: 50, voiceQuery: async () => [] });
  const t0 = Date.now();
  await assert.rejects(codex.list(), /didn't answer thread\/list/);
  assert.ok(Date.now() - t0 < 1000);
  codex.stop();
});

test('reliability: Codex dying mid-turn ends the turn with a message and leaves the session idle', async () => {
  const hub = new Hub();
  let proc;
  const spawn = (...a) => { proc = fakeCodexSpawn([])(...a); return proc; };
  const codex = makeCodex({ hub, spawn, voiceQuery: async () => [] });
  const s = await codex.start({ cwd: '/tmp', text: 'run tests' });
  await until(() => s.events.find((e) => e.kind === 'ask'));
  proc.emit('exit', 1);
  assert.equal(s.status, 'idle');
  assert.equal(s.pending.size, 0, 'the open approval is cancelled');
  assert.match(s.events.findLast((e) => e.kind === 'error').text, /stopped unexpectedly/);
});

test('reliability: a turn Codex refuses to start does not leave the session looking busy', async () => {
  const hub = new Hub();
  const refusing = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', 0);
    const out = (m) => proc.stdout.write(`${JSON.stringify(m)}\n`);
    proc.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) {
      const m = JSON.parse(l);
      if (m.method === 'initialize') out({ id: m.id, result: {} });
      else if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: 'th9' } } });
      else if (m.method === 'turn/start') out({ id: m.id, error: { message: 'usage limit reached' } });
    } });
    return proc;
  };
  const codex = makeCodex({ hub, spawn: refusing, voiceQuery: async () => [] });
  await assert.rejects(codex.start({ cwd: '/tmp', text: 'hi' }), /usage limit/);
  assert.equal(hub.get('codex:th9').status, 'idle');
  codex.stop();
});

test('reliability: a missing Grok lists nothing and says why on start', async () => {
  const { makeAcp } = await import('../src/acp.mjs');
  const hub = new Hub();
  const grok = makeAcp({ hub, agent: 'grok', label: 'Grok', command: ['grok', 'agent', 'stdio'], spawn: missingSpawn() });
  assert.deepEqual(await grok.list(), []);
  await assert.rejects(grok.start({ cwd: '/tmp', text: 'hi' }), /Grok isn't installed/);
});

test('reliability: one damaged Antigravity journal hides only itself', async () => {
  const { makeAgy } = await import('../src/agy.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'walkie-agy-'));
  writeFileSync(join(dir, 'good.jsonl'), `${JSON.stringify({ id: 'u', kind: 'user', text: 'hi', cwd: '/tmp', title: 'Good' })}\nnot json\n`);
  writeFileSync(join(dir, 'bad.jsonl'), '{oops');
  const agy = makeAgy({ hub: new Hub(), journalDir: dir });
  assert.deepEqual((await agy.list()).map((r) => r.title), ['Good']);
  assert.deepEqual((await agy.history('good')).map((e) => e.text), ['hi']);
});

test('reliability: a hung agent list never hangs the phone\'s session list', async () => {
  const hub = new Hub();
  const claude = makeClaude({ hub, query: fakeQuery([]), listSessions: async () => [{ sessionId: 's1', summary: 'Fine', lastModified: 5, cwd: '/Users/x/app' }], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} } });
  const stuck = { agent: 'codex', list: () => new Promise(() => {}), history: async () => [] };
  const server = makeServer({ hub, adapters: { claude, codex: stuck }, apiKey: 'k', listTimeoutMs: 100 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions`, { headers: { 'x-api-key': 'k', 'x-walkie-agents': 'claude,codex' } }).then((x) => x.json());
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(r.sessions.map((s) => s.title), ['Fine']);
  } finally { server.close(); }
});

test('reliability: the phone\'s ping gets a pong', async () => {
  const hub = new Hub();
  const server = makeServer({ hub, adapters: {}, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?key=k`);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'ping', id: 7 }));
    assert.deepEqual(await until(() => frames.find((f) => f.type === 'pong')), { type: 'pong', id: 7 });
    ws.close();
  } finally { server.close(); }
});

test('continue: a new conversation on another subscription starts with this one, and the old one links to it', async () => {
  const { MESSAGE_MARK } = await import('../src/handoff.mjs');
  const hub = new Hub();
  const old = hub.open({ agent: 'claude', id: 'c1', cwd: '/tmp', title: 'Fix the login bug' });
  old.push({ kind: 'user', text: 'The login button does nothing' });
  old.push({ kind: 'text', text: 'Found it: the handler is never attached.' });
  const started = [];
  const codex = { agent: 'codex', list: async () => [], history: async () => [], start: async (o) => { started.push(o); return hub.open({ agent: 'codex', id: 'x1', cwd: o.cwd }); } };
  const server = makeServer({ hub, adapters: { claude: makeClaude({ hub, query: fakeQuery([]), listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} } }), codex }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/session`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'codex', cwd: '/tmp', text: 'Attach it and add a test', continueFrom: 'claude:c1' }) });
    assert.equal(r.status, 200);
    const text = started[0].text;
    assert.match(text, /^\[Continued from a Claude Code conversation: "Fix the login bug"\]/);
    assert.match(text, /Me: The login button does nothing\n\nAgent: Found it/);
    assert.ok(text.endsWith(`${MESSAGE_MARK}\nAttach it and add a test`));
    const link = old.events.findLast((e) => e.kind === 'info');
    assert.deepEqual([link.text, link.link], ['Continued in Codex', 'codex:x1']);
  } finally { server.close(); }
});

test('continue: a hand-off of a hand-off carries only what was typed, newest kept when long', async () => {
  const { excerpt, handoffText, MESSAGE_MARK } = await import('../src/handoff.mjs');
  const first = handoffText({ from: 'Codex', title: 't', cwd: '/x', events: [{ kind: 'user', text: 'old words' }], text: 'new words' });
  assert.equal(excerpt([{ kind: 'user', text: first }]), 'Me: new words');
  assert.ok(!first.includes(`${MESSAGE_MARK}\n${MESSAGE_MARK}`));
  const long = Array.from({ length: 50 }, (_, i) => ({ kind: i % 2 ? 'text' : 'user', text: `message ${i} ${'x'.repeat(500)}` }));
  const kept = excerpt(long, 2000);
  assert.ok(kept.length <= 2000);
  assert.match(kept, /message 49/);
  assert.doesNotMatch(kept, /message 0 /);
});

test('usage: Antigravity\'s quota groups become meters', async () => {
  const { agyWindows } = await import('../src/usage.mjs');
  const w = agyWindows({ groups: [
    { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-10-18T23:09:04Z' }] },
    { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-18T23:09:04Z' }] },
  ] });
  assert.deepEqual(w.map((x) => [x.name, x.usedPct]), [['Week · Gemini', 75], ['Week · Claude and GPT', 0]]);
  assert.equal(w[0].resetsAt, Date.parse('2026-10-18T23:09:04Z'));
  assert.deepEqual(agyWindows(null), []);
});

test('delivery: a start retried while the first is still booting gets the same session, not a second one', async () => {
  const hub = new Hub();
  let starts = 0; let release;
  const slow = { agent: 'codex', list: async () => [], history: async () => [], start: async (o) => { starts++; await new Promise((r) => { release = r; }); return hub.open({ agent: 'codex', id: 'slow1', cwd: o.cwd }); } };
  const server = makeServer({ hub, adapters: { codex: slow }, apiKey: 'k' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/session`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'codex', cwd: '/tmp', text: 'hi', clientId: 'same' }) }).then((r) => r.json());
  try {
    const first = post();
    await until(() => release);
    const retry = post();
    await tick(50);
    release();
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(starts, 1);
    assert.equal(a.session.key, 'codex:slow1');
    assert.equal(b.session.key, 'codex:slow1');
    assert.equal(b.duplicate, true);
  } finally { server.close(); }
});

test('send to projects: the plan turn lists real project folders; dispatch starts one session per task and links both ways', async () => {
  const { PLAN_MARK } = await import('../src/handoff.mjs');
  const root = mkdtempSync(join(tmpdir(), 'walkie-roots-'));
  for (const p of ['alpha', 'beta']) mkdirSync(join(root, p, '.git'), { recursive: true });
  const hub = new Hub();
  const sent = []; const started = [];
  let n = 0;
  const fake = (agent) => ({
    agent, list: async () => [], history: async () => [],
    send: async (s, text) => { sent.push(text); },
    start: async (o) => { started.push({ agent, ...o }); return hub.open({ agent, id: `s${++n}`, cwd: o.cwd }); },
  });
  const coord = hub.open({ agent: 'claude', id: 'coord', cwd: root, title: 'Monday planning' });
  const server = makeServer({ hub, adapters: { claude: fake('claude'), codex: fake('codex') }, apiKey: 'k', projectRoots: [root] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    assert.equal((await api('/api/session/plan', { key: 'claude:coord' })).status, 200);
    assert.ok(sent[0].startsWith(PLAN_MARK));
    assert.match(sent[0], new RegExp(`- ${join(root, 'alpha')}`));

    const tasks = [
      { cwd: join(root, 'alpha'), agent: 'claude', brief: 'Ship the login fix' },
      { cwd: join(root, 'beta'), agent: 'codex', model: 'gpt-6', brief: 'Add the export button' },
      { cwd: join(root, 'gone'), agent: 'codex', brief: 'Nothing here' },
    ];
    const r = await api('/api/dispatch', { from: 'claude:coord', tasks, clientId: 'd1' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sessions.map((s) => s.key), ['claude:s1', 'codex:s2']);
    assert.equal(r.json.failed.length, 1, 'a missing folder fails only its own task');
    assert.match(r.json.failed[0].error, /doesn't exist/);
    assert.deepEqual(started.map((s) => [s.agent, s.text, s.model]), [['claude', 'Ship the login fix', undefined], ['codex', 'Add the export button', 'gpt-6']]);
    assert.deepEqual(coord.events.filter((e) => e.link).map((e) => [e.text, e.link]), [['Started in alpha · Claude Code', 'claude:s1'], ['Started in beta · Codex', 'codex:s2']]);
    assert.equal(hub.get('codex:s2').events.find((e) => e.link).link, 'claude:coord');

    const again = await api('/api/dispatch', { from: 'claude:coord', tasks, clientId: 'd1' });
    assert.equal(again.json.duplicate, true);
    assert.deepEqual(again.json.sessions.map((s) => s.key), ['claude:s1', 'codex:s2'], 'a retry gets the first answer and starts nothing');
    assert.equal(started.length, 2);
  } finally { server.close(); }
});

test('customize: ~/.walkie/walkie.json names and hides projects and adds quick asks; bad entries hide only themselves', async () => {
  const { makeCustomize, parseCustomize } = await import('../src/customize.mjs');
  const { writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'walkie-roots-'));
  for (const p of ['alpha', 'beta']) mkdirSync(join(root, p, '.git'), { recursive: true });
  const file = join(mkdtempSync(join(tmpdir(), 'walkie-cfg-')), 'walkie.json');
  writeFileSync(file, JSON.stringify({
    asks: [{ title: 'Tests', text: 'Run the tests.' }, { title: 'no text' }, 'junk'],
    projects: { [join(root, 'alpha')]: { name: 'The Alpha', asks: [{ title: 'Ship', text: 'Ship it.' }] }, [join(root, 'beta')]: { hidden: true }, relative: { name: 'x' } },
  }));
  const changes = [];
  const customize = makeCustomize({ file, onChange: () => changes.push(1) });
  const hub = new Hub();
  const claude = makeClaude({ hub, query: fakeQuery([]), listSessions: async () => [], getSessionMessages: async () => [], running: { get: async () => new Map(), watch: () => () => {} } });
  const server = makeServer({ hub, adapters: { claude }, apiKey: 'k', projectRoots: [root], customize });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { 'x-api-key': 'k' } }).then((r) => r.json());
  try {
    assert.deepEqual((await get('/api/projects')).projects.map((p) => p.name), ['The Alpha'], 'beta is hidden, alpha renamed');
    assert.deepEqual((await get(`/api/asks?cwd=${encodeURIComponent(join(root, 'alpha'))}`)).asks.map((a) => a.title), ['Ship', 'Tests']);
    assert.deepEqual((await get('/api/asks')).asks.map((a) => a.title), ['Tests']);
    writeFileSync(file, '{not json');
    await until(() => changes.length);
    assert.deepEqual((await get('/api/asks')).asks, [], 'a broken file means no asks, not a broken bridge');
    assert.deepEqual(parseCustomize('null'), { asks: [], projects: {} });
  } finally { server.close(); }
});
