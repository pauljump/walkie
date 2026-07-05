// LocalBus — a dependency-free WS + REST server that is a BYTE-COMPATIBLE drop-in for the
// @agent-relay/broker on the phone-facing surface. The iOS app (BrokerClient.swift) needs ZERO
// changes: it dials the exact same endpoints, sends the same frames, and reads the same frames.
//
// This replaces the broker binary's phone on-ramp for the SELF-HOST path. The conductor side is
// separate (see bus.mjs / spawn-claude.mjs) — LocalBus is a pure local relay: it does NOT reach
// out to hosted Relaycast, so the shipped self-host path needs no rk_live_ workspace key and no
// ~/.secrets. Everything it needs comes from config.mjs / WALKIE_* env.
//
// Why hand-rolled WebSocket? `ws` is not a dependency (and shouldn't be — self-host wants a tiny,
// audit-able surface). Node 22 ships a WebSocket *client* global but no server, so we implement
// the small, well-defined RFC 6455 server handshake + text-frame codec on top of node:http. We
// only speak what the app speaks: UTF-8 TEXT frames + control frames (ping/pong/close).
//
// The wire contract (reverse-engineered from BrokerClient.swift / e2e-loop.mjs / local-broker.md):
//
//   GET  /ws           WebSocket upgrade. x-api-key required (else 401). On open: replay the FULL
//                      retained history of ALL channels, each as its own TEXT JSON frame carrying
//                      its ORIGINAL seq; then push every newly published message live. Accept and
//                      ignore the app's {"type":"subscribe",...} control frame.
//   POST /api/send     Publish. x-api-key required (else 401). Body { from, to, text }. "to" must
//                      be "#<channel>" (a bare name → 404, matching the broker's agent-DM rule).
//                      Empty text → 200 without publishing (reachability ping only). Otherwise
//                      append to history with the next monotonic seq (from preserved verbatim) and
//                      broadcast. Returns 200.
//   GET  /api/status   UNAUTHENTICATED: readiness only, no secrets. Returns 200 with
//                      {ok, busUp, seq, clients, ...readiness}. Readable BEFORE the phone has the
//                      key so the app can show a setup/readiness screen up front. It carries only
//                      booleans + counts (never the sk-ant / br key values), same "readable so the
//                      app reads reachability" spirit as the root 404. /api/send + /ws stay authed.
//
// Inbound frame shape emitted to /ws clients (what the app DECODES):
//   { "from": <publisher>, "body": <text>, "target": "#<channel>", "seq": <monotonic int>, "kind"? }
// The app reads body ?? text, routes by target (# stripped, lowercased), and only SPEAKS #standup
// frames whose from == "Mara"; #work shows any non-empty from. So publishers MUST preserve their
// own "from" (Mara / Director / an engineer name) verbatim — LocalBus never rewrites it.
//
// Seq is a single monotonic counter over the whole server, stamped once at publish time and stored
// with the message. Replay re-sends the SAME seq, so the app's high-water-mark dedup drops
// already-seen frames on reconnect and never re-speaks the backlog (the bug PR #100 fixed). We
// never renumber on reconnect.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 magic

// Normalize a channel: strip a single leading '#', lowercase. "#Standup" -> "standup".
const chanOf = (to) => String(to ?? '').replace(/^#/, '').toLowerCase();

// Case-insensitive header read (Node lowercases header keys, but be defensive).
function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export class LocalBus extends EventEmitter {
  // channels: the channels this bus retains + forwards (matches the broker's --channels).
  // readiness: an object OR a zero-arg function returning one — the extra readiness signals
  // (transport, maraReady, sandboxReady, needs) that the config-aware caller (bus.mjs) injects.
  // Function form is preferred so it re-reads LIVE state per request (e.g. the sandbox git dir
  // appearing after the installer runs, or a key added in Settings after boot). LocalBus never
  // imports config.mjs — it stays a pure relay; all readiness knowledge is passed in here.
  constructor({ bind = '0.0.0.0', port = 3889, apiKey = 'br_walkie', channels = ['standup', 'work'], log = () => {}, readiness = () => ({}) } = {}) {
    super();
    this.bind = bind;
    this.port = Number(port);
    this.apiKey = String(apiKey);
    this.channels = new Set(channels);
    this.log = log;
    this.readiness = readiness;
    this.history = [];       // append-only [{ from, text, channel, kind, seq }] across ALL channels
    this.seq = 0;            // single monotonic counter, stamped at publish, stable across reconnect
    this.clients = new Set(); // live WS client sockets (net.Socket)
    this.server = null;
  }

  // ── auth ────────────────────────────────────────────────────────────────────────────────
  #authed(req) {
    return header(req, 'x-api-key') === this.apiKey;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────
  async start() {
    this.server = createServer((req, res) => this.#onRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.bind, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // If port 0 was passed (tests), reflect the OS-assigned port back.
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
    this.log(`[local-bus] listening on ${this.bind}:${this.port}  (channels: ${[...this.channels].join(',')}; key ${this.apiKey})`);
    return this;
  }

  async stop() {
    for (const sock of this.clients) { try { sock.destroy(); } catch {} }
    this.clients.clear();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
  }

  // ── publish (the ONE write path; used by REST and by the in-process conductor side) ───────
  // Preserves `from` verbatim. Stamps the next monotonic seq. Appends to history and broadcasts
  // to every live client. Returns the stored message (incl. its seq).
  publish({ from, text, channel, kind }) {
    const ch = chanOf(channel);
    const msg = { from: String(from ?? ''), text: String(text ?? ''), channel: ch, kind: kind ?? undefined, seq: ++this.seq };
    this.history.push(msg);
    const wire = this.#frame(msg);
    for (const sock of this.clients) this.#sendText(sock, wire);
    // Let the in-process conductor observe every published message (its inbound side).
    this.emit('message', { from: msg.from, text: msg.text, channel: ch, seq: msg.seq });
    this.log(`[local-bus] ${msg.from} → #${ch} (seq ${msg.seq}): ${msg.text.slice(0, 80)}`);
    return msg;
  }

  // The exact JSON the app decodes. "body" is preferred (app reads body ?? text); "target" carries
  // the "#channel" so the app routes correctly; "seq" drives dedup. kind is included only if set.
  #frame(msg) {
    const f = { from: msg.from, body: msg.text, target: `#${msg.channel}`, seq: msg.seq };
    if (msg.kind) f.kind = msg.kind;
    return JSON.stringify(f);
  }

  // ── REST ─────────────────────────────────────────────────────────────────────────────────
  #onRequest(req, res) {
    const url = req.url || '/';
    const path = url.split('?')[0];

    // /api/status is UNAUTHENTICATED on purpose (no x-api-key): the app must be able to render its
    // readiness screen BEFORE the user has typed/scanned the key, and a probe here must never 401.
    // It exposes only booleans + counts merged from the injected readiness provider — never a secret
    // (maraReady is a boolean; the sk-ant/br key values are never echoed). If this handler runs, the
    // bus is up, so busUp is trivially true. This branch is ABOVE the authed routes below.
    if (req.method === 'GET' && path === '/api/status') {
      const base = { ok: true, busUp: true, seq: this.seq, clients: this.clients.size };
      const extra = typeof this.readiness === 'function' ? this.readiness() : this.readiness;
      return this.#json(res, 200, { ...base, ...extra });
    }

    if (req.method === 'POST' && path === '/api/send') {
      if (!this.#authed(req)) return this.#json(res, 401, { error: 'unauthorized' });
      return this.#readBody(req, (err, body) => {
        if (err) return this.#json(res, 400, { error: 'bad body' });
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return this.#json(res, 400, { error: 'invalid json' }); }
        const { from, to, text } = parsed;
        // "to" must be "#<channel>". A bare name is an agent DM target → 404 (broker parity).
        if (typeof to !== 'string' || !to.startsWith('#')) {
          return this.#json(res, 404, { error: 'agent_not_found', hint: 'address a channel as "#name"' });
        }
        // Empty-text ping (testConnection / Settings test): only a reachability probe. Answer 200
        // WITHOUT publishing an empty message.
        if (text == null || String(text).trim() === '') return this.#json(res, 200, { ok: true, ping: true });
        const ch = chanOf(to);
        const msg = this.publish({ from: from ?? 'Director', text, channel: ch });
        return this.#json(res, 200, { ok: true, seq: msg.seq });
      });
    }

    // Anything else at root: a plain 404 (NOT 401/403), so the app's testConnection still reads it
    // as "reachable" if it ever probes an odd path.
    return this.#json(res, 404, { error: 'not_found' });
  }

  #readBody(req, cb) {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { tooBig = true; req.destroy(); } // 1MB cap; directives are tiny
    });
    req.on('end', () => cb(tooBig ? new Error('too big') : null, data));
    req.on('error', (e) => cb(e));
  }

  #json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  // ── WebSocket upgrade (GET /ws) ───────────────────────────────────────────────────────────
  #onUpgrade(req, socket, head) {
    const path = (req.url || '').split('?')[0];
    if (path !== '/ws') return this.#refuse(socket, 404, 'Not Found');
    // Auth on the upgrade request itself (app sets x-api-key on the URLRequest). Bad key → 401 so
    // the app's testConnection maps it to .unauthorized.
    if (!this.#authed(req)) return this.#refuse(socket, 401, 'Unauthorized');
    const key = header(req, 'sec-websocket-key');
    if (!key) return this.#refuse(socket, 400, 'Bad Request');

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    this.clients.add(socket);
    this.log(`[local-bus] ws client connected (${this.clients.size} live)`);

    // Replay the FULL history of ALL channels, in original order, each with its ORIGINAL seq. This
    // is the behavior the app defends against (catch-up window + seq high-water dedup): a replayed
    // old frame carries its old seq, so it's dropped and never re-spoken.
    for (const msg of this.history) this.#sendText(socket, this.#frame(msg));

    // Parse inbound frames from THIS client (the subscribe control frame; ping/pong/close).
    this.#attachReceiver(socket, head);
  }

  #refuse(socket, code, text) {
    try {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    } catch {}
  }

  // Minimal RFC 6455 receive path: reassembles client frames, handles the {"type":"subscribe"}
  // control frame by ACCEPTING and IGNORING it (never error/close), answers ping with pong, and
  // closes cleanly on a close frame. Client→server frames are masked per spec; we unmask them.
  #attachReceiver(socket, head) {
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const drop = () => { this.clients.delete(socket); this.log(`[local-bus] ws client gone (${this.clients.size} live)`); };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Decode as many complete frames as are buffered.
      for (;;) {
        const parsed = this.#decodeFrame(buf);
        if (!parsed) break;         // need more bytes
        buf = parsed.rest;
        const { opcode, payload } = parsed;
        if (opcode === 0x8) { this.#sendClose(socket); return drop(); }  // close
        if (opcode === 0x9) { this.#sendPong(socket, payload); continue; } // ping → pong
        if (opcode === 0xA) continue;                                      // pong: ignore
        // opcode 0x1 (text) / 0x2 (binary) / 0x0 (continuation): the ONLY thing the app sends is
        // the subscribe control text frame — accept and ignore. We never error/close on it.
        // (We don't need to act on it; LocalBus forwards all channels regardless.)
      }
    });
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('end', drop);
  }

  // Decode one client→server frame from buf. Returns { opcode, payload, rest } or null if buf is
  // incomplete. Handles the mask (mandatory client→server) and 7/16/64-bit length forms.
  #decodeFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      // Directives are tiny; 32-bit range is plenty and avoids BigInt.
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      len = hi * 2 ** 32 + lo;
      offset += 8;
    }
    let maskKey;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4); offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    return { opcode, payload, rest: buf.subarray(offset + len) };
  }

  // Encode + send an UNMASKED (server→client) text frame. The app only handles .string frames.
  #sendText(socket, text) {
    if (!socket.writable) return;
    const data = Buffer.from(text, 'utf8');
    try { socket.write(this.#encode(0x1, data)); } catch {}
  }

  #sendPong(socket, payload) {
    try { socket.write(this.#encode(0xA, payload || Buffer.alloc(0))); } catch {}
  }

  #sendClose(socket) {
    try { socket.write(this.#encode(0x8, Buffer.alloc(0))); } catch {}
  }

  // Server→client frames are NOT masked. FIN=1, single-frame.
  #encode(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    return Buffer.concat([header, payload]);
  }
}
