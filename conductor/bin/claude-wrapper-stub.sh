#!/bin/bash
# claude-wrapper-stub.sh — a minimal, annotated example of the `claude` shim.
#
# This is the TEACHING version of bin/claude: it shows the shape of the jail injection without
# the production fallbacks. Use it to understand the flow, to test the jail by hand, or as a
# starting template. The real, hardened shim is bin/claude (installed on the launchd PATH).
#
# The idea in three lines:
#   1. the harness spawns `claude …`; PATH resolves it to this shim (bin/ is first on PATH)
#   2. the shim builds a per-worker sandbox-exec profile (jail-profile.sh)
#   3. the shim execs the REAL claude under `sandbox-exec -f <profile>` — jailed, but logged in
#
# Try it by hand (proves the jail without touching the harness):
#   WALKIE_PROFILE_DENY=1 \
#   WALKIE_WORKER_NAME=demo \
#   WALKIE_SANDBOX_DIR=/tmp/walkie-demo-sandbox \
#   WALKIE_REAL_CLAUDE=/bin/ls \
#   bash bin/claude-wrapper-stub.sh /tmp/walkie-demo-sandbox
#     → runs `ls` jailed; try pointing it at ~/.ssh and watch it get denied.
set -u

self_dir="$(cd "$(dirname "$0")" && pwd)"

# 1. Where's the real thing? (Here we take an explicit override for the demo; the real shim
#    auto-resolves from ~/.local/bin, homebrew, etc.)
REAL_CLAUDE="${WALKIE_REAL_CLAUDE:-/opt/homebrew/bin/claude}"
if [ ! -x "$REAL_CLAUDE" ]; then
  echo "stub: real claude not found at $REAL_CLAUDE (set WALKIE_REAL_CLAUDE)" >&2
  exit 127
fi

# 2. Jail off? Just run it. (Trusted dev machine.)
if [ "${WALKIE_PROFILE_DENY:-0}" != "1" ]; then
  echo "stub: jail OFF — passthrough" >&2
  exec "$REAL_CLAUDE" "$@"
fi

# 3. Jail on. Generate the profile for this worker + sandbox dir, then exec under it.
worker="${WALKIE_WORKER_NAME:-worker}"
sandbox_dir="${WALKIE_SANDBOX_DIR:-}"
state_dir="${WALKIE_STATE_DIR:-$HOME/.walkie}"

profile="$(bash "$self_dir/../src/jail-profile.sh" "$worker" "$sandbox_dir" "$state_dir")"
echo "stub: jailing $worker with $profile (writeable: $sandbox_dir + $state_dir)" >&2

exec sandbox-exec -f "$profile" "$REAL_CLAUDE" "$@"
