# Local Agent Relay broker — proven runbook (Fork 2 closed, 2026-06-13)

How to run a local `agent-relay` broker and connect both a Node conductor and the
Swift (phone) client to it. Verified end to end: the Swift Director subscribed,
posted, and received live messages against a local broker on `127.0.0.1:3889`.

## Two key types — do not confuse them
- `rk_live_…` — hosted **Relaycast workspace key**. The broker uses it outbound; it is
  **mandatory** (`AGENT_RELAY_DISABLE_RELAYCAST` is rejected). Mint via the Node SDK:
  `AgentRelay.createWorkspace({name}).workspaceKey`.
- `br_…` — the **local broker's client-auth key**. Clients (Swift, curl) authenticate to
  the broker with this via `X-API-Key`. Set it with `RELAY_BROKER_API_KEY`; it's written
  to `connection.json`.

## Start the broker
```bash
BROKER=node_modules/@agent-relay/broker-darwin-arm64/bin/agent-relay-broker
RELAY_BROKER_API_KEY=br_fork2dev \
  "$BROKER" init --persist --api-bind 127.0.0.1 --api-port 3889 \
  --workspace-key "$RK_LIVE_WORKSPACE_KEY" --channels standup
```
- Logs `API listening on http://127.0.0.1:3889`; writes `.agentworkforce/relay/connection.json`
  (`{api_key, pid, port, url}`).
- One axum server serves **`GET /ws` AND `POST /api/send` at root on :3889**. (The hosted
  `gateway.relaycast.dev` serves `/ws` but NOT `/api/send` — that's why hosted `post()` 404'd.)

## Channel addressing
- Channels are addressed with a leading `#`: `{"to":"#standup"}` → 200. Without `#`,
  `to` is treated as an agent DM target → 404 `agent_not_found`.

## Swift (phone) client — no code change for the URL
- `AgentRelayClient` defaults `baseURL` to `http://localhost:3889`. Just pass the **`br_`**
  key as `apiKey` (NOT the `rk_live_` key — the local `/api/*` + `/ws` auth checks the broker key).
- `client.channel("#standup").subscribe()` → `GET /ws`; `.post("…")` → `POST /api/send`. Both succeed.

## Node conductor caveat (residual risk)
- The JS `@agent-relay/sdk` retargets only via a lowercase `baseUrl` option (no env var).
- BUT the local broker serves the broker REST surface (`/api/send`, `/ws`), while the JS SDK's
  HTTP client may expect the Relaycast `/v1/*` shape. If `createWorkspace`/`register` against
  `baseUrl: http://localhost:3889` 404s, the conductor should talk the broker REST directly
  (`POST /api/send`, subscribe `/ws`) like the Swift client and curl do — i.e. treat the broker
  as the relay runtime and post over `/api/send`. Verify with the `/api/send` curl before wiring.

## Proven round-trip (2026-06-13)
Swift Director against the local broker:
- `subscribed to #standup` ✓
- `post()` → 200 (no 404); directive landed in `#standup` (phone → conductor) ✓
- an external `POST /api/send` from "EM" arrived at the Swift subscriber **live** (conductor → phone) ✓

## Privacy note (Fork 3)
The broker runs on the Mac Mini (phone → Mac over Tailscale), but it still maintains a
**mandatory outbound Relaycast connection** (`relaycast_published: true`). Local broker ≠
air-gapped. Full privacy needs a disable flag or a self-hosted relay backend.
