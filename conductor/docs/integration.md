# Walkie integration — "the mannequin breathes" (first end-to-end loop, 2026-06-13)

> **⚠️ HISTORICAL — this describes the original hosted-relay (Relaycast/`agent-relay`) path.**
> The shipped self-host default is now **LocalBus** (`transport: "local"`): a dependency-free
> WS+REST bus on your own Mac, **no hosted relay and no `rk_live_` workspace key**. The builder
> is a direct one-shot `claude` spawn, not a hosted harness worker. You do NOT need any of the
> `rk_live_`/`~/.secrets` keys below for a normal self-host install. This document is kept only
> as the reference for the optional `transport: "agent-relay"` fallback (the future cloud spine).
> For the current setup start with `docs/SELF_HOST_SETUP.md` and `docs/local-broker.md`.

The first real talk → build → review loop. A Director directive from the phone reaches the
EM conductor, which dispatches a real harness worker, holds the verification gate, and
surfaces only the curated result back to the phone. Proven end to end with a live Claude
worker (see `npm run e2e`).

## Architecture (proven, not theorized)

```
  iPhone (Director)                 Mac Mini                          Relaycast (hosted)
  ┌──────────────┐   ws /ws +     ┌──────────────┐   joins workspace  ┌──────────────────┐
  │ Walkie app   │◀──POST /api/──▶│ local broker │◀──────────────────▶│  walkie workspace │
  │ BrokerClient │   send         │ "Director"   │   (rk_live_ key)   │     #standup      │
  └──────────────┘                └──────────────┘                    └─────────┬────────┘
                                                                                │ SDK (rk_live_)
                                                                      ┌─────────┴────────┐
                                                                      │  EM conductor    │
                                                                      │  "Mara" + workers│
                                                                      └──────────────────┘
```

Both on-ramps join **one** hosted workspace, so they converge on `#standup`:
- **Phone** → local broker (`/api/send` + `/ws`, `br_` auth). The broker relays to the
  workspace both ways (proven bidirectional in the bridge scout).
- **Conductor + its harness agents** → the SDK directly against the hosted workspace
  (`rk_live_` workspace key). The conductor does **not** tunnel through the broker — the
  broker can't spawn agents for it, so that would orphan it from its own workers.

Why this and not "conductor speaks broker REST" (the original guess): harness workers can
only join via the SDK's `/v1/ws`, so the conductor must live where they live (hosted). The
broker is the **phone's** on-ramp, and it faithfully bridges the workspace in both directions.

## Keys

- `WALKIE_RELAY_WORKSPACE_KEY` (`rk_live_…`, in `~/.secrets/monorepo.env`) — the stable
  workspace the broker joins and the conductor attaches to. (The old `RELAY_API_KEY` was
  stale/invalid — minted fresh 2026-06-13.)
- `WALKIE_BROKER_API_KEY` (`br_…`, default `br_walkie`) — the client-auth key the phone
  presents to the broker via `x-api-key`.

## Run the loop

```bash
cd walkie/conductor && npm i
node src/broker.mjs        # terminal A — the phone's on-ramp (binds 0.0.0.0:3889)
node src/run-live.mjs      # terminal B — the EM, attached to the shared workspace
```

Then the phone (or `npm run e2e`) posts a directive to `#standup` as **Director**. The EM
acks (`👋 on it`), dispatches a worker, and surfaces `✅ <worker>: …` on verification.

- **`npm run e2e`** — full self-contained proof: spawns the broker, runs the conductor,
  simulates the phone over the broker, drives a real Claude (sonnet) worker, asserts the
  result lands back on the phone. `WALKIE_E2E_DRY=1` runs the plumbing with no worker ($0).

## Director identity (a wrinkle worth knowing)

The broker stamps its `--instance-name` as the `from` of everything the phone posts. We
name the instance **`Director`**, so the conductor's `watch({ directiveFrom: 'Director' })`
recognizes phone posts as directives — and ignores its own echoes and worker chatter.

## v1 simplification — one channel (next: two)

For this first loop everything rides `#standup` and the phone filters client-side to show
only the EM ("Mara"). The keystone is **two channels** (workers coordinate on a work
channel the phone never sees; only the EM reaches the Director). The clean split: workers
post to `#work`, the broker joins only `#standup`, so the phone is structurally deaf to
worker chatter. That's the next refinement, not yet wired.
