#!/bin/bash
# Walkie always-on service: the broker (the phone's on-ramp) + the live conductor (Mara +
# the team), run under launchd so Walkie is waiting whenever the Director picks up his phone.
# Auth note: launchd runs this as the user WITHOUT a Claude Code session token, so the
# builders authenticate through the persistent keychain subscription login (proven: KEYCHAIN_OK).
# Self-host: all per-user settings come from ~/.walkie/config.json (validated below).
set -u
CONDUCTOR="$(cd "$(dirname "$0")/.." && pwd)"   # -> walkie/conductor
cd "$CONDUCTOR" || exit 1
mkdir -p "$HOME/.walkie"

# Make the 'claude' shim win PATH resolution so a jailed build (if the operator opted in) wraps
# the real CLI. The shim lives in $RUN/bin (../../bin from here). When the jail is off (the
# default) the shim is a transparent passthrough, so this is harmless either way.
RUNBIN="$(cd "$CONDUCTOR/../../bin" 2>/dev/null && pwd || true)"
[ -n "${RUNBIN:-}" ] && export PATH="$RUNBIN:$PATH"
# The jail is NOT forced here. cfg.jailProfile (~/.walkie/config.json) is the single source of
# truth: run-live reads it and the spawner injects WALKIE_PROFILE_DENY per-build for the shim.
# We deliberately do NOT export WALKIE_PROFILE_DENY so a stale env can never override the config.
export WALKIE_STATE_DIR="${WALKIE_STATE_DIR:-$HOME/.walkie}"

# Config gate: refuse to start on a missing/broken config so we fail loud, not in a crash-loop.
CONFIG="$HOME/.walkie/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "$(date -u +%FT%TZ) [walkie-service] no config at $CONFIG — run: bash scripts/install-service.sh --init" >&2
  exit 1
fi
WALKIE_CONFIG_PATH="$CONFIG" node --input-type=module -e '
  import { validateConfig } from "'"$CONDUCTOR"'/src/config.mjs";
  const v = validateConfig();
  if (!v.ok) { for (const p of v.problems) console.error("[walkie-service] config problem: " + p.key + " — " + p.message); process.exit(1); }
' || { echo "$(date -u +%FT%TZ) [walkie-service] config invalid — not starting" >&2; exit 1; }

# Report the jail state from the config (the source of truth) so the log matches reality.
JAIL_STATE="$(WALKIE_CONFIG_PATH="$CONFIG" node --input-type=module -e '
  import { loadConfig } from "'"$CONDUCTOR"'/src/config.mjs";
  process.stdout.write(loadConfig().jailProfile === true ? "on" : "off");
' 2>/dev/null || echo "off")"
if [ "$JAIL_STATE" = "on" ]; then
  echo "$(date -u +%FT%TZ) [walkie-service] jail ON (sandbox-exec via $RUNBIN/claude) — needs a BYO API key"
else
  echo "$(date -u +%FT%TZ) [walkie-service] jail OFF (default) — builders use your Claude subscription login"
fi

# Clear any stale processes so we don't collide on the port / the single-instance lock.
# ESCALATE: run-live traps SIGTERM (Bonjour reaper) and has been seen surviving a plain pkill
# for 22+ hours while holding :3889 — the "stale process serves old code" bug. TERM first
# (graceful), verify, then KILL anything still standing.
pkill -f 'agent-relay-broker' 2>/dev/null || true
pkill -f 'src/run-live.mjs' 2>/dev/null || true
for _ in 1 2 3 4 5; do pgrep -f 'src/run-live.mjs' >/dev/null 2>&1 || break; sleep 1; done
if pgrep -f 'src/run-live.mjs' >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) [walkie-service] old conductor ignored SIGTERM — escalating to SIGKILL"
  pkill -9 -f 'src/run-live.mjs' 2>/dev/null || true
  sleep 1
fi

# Broker in the background; the conductor in the foreground (launchd monitors this script).
node src/broker.mjs > "$HOME/.walkie/broker.log" 2>&1 &
BROKER=$!
trap 'kill "$BROKER" 2>/dev/null' EXIT INT TERM

# On the default local transport the bus lives INSIDE run-live and broker.mjs exits after a
# note — waiting for its "API listening" line would just burn the full timeout on every boot.
# Only wait when the hosted agent-relay broker actually runs.
TRANSPORT="$(WALKIE_CONFIG_PATH="$CONFIG" node --input-type=module -e '
  import { loadConfig } from "'"$CONDUCTOR"'/src/config.mjs";
  process.stdout.write(loadConfig().transport || "local");
' 2>/dev/null || echo local)"
if [ "$TRANSPORT" = "agent-relay" ]; then
  for _ in $(seq 1 30); do grep -q "API listening" "$HOME/.walkie/broker.log" 2>/dev/null && break; sleep 1; done
fi
node src/run-live.mjs
