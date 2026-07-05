#!/bin/bash
# Deploy Walkie as a durable launchd service.
#
# macOS protects ~/Desktop from background processes (TCC), so a launchd job cannot run the
# conductor straight out of the repo (the monorepo lives under ~/Desktop). This mirrors just
# what the conductor needs to ~/walkie-run (outside Desktop) and points the LaunchAgent there.
# Re-run after code changes to redeploy. Builders auth via the keychain subscription login
# (launchd has no Claude session token) — flat, durable, no API key.
#
#   bash scripts/install-service.sh            # deploy + (re)load (validates config first)
#   bash scripts/install-service.sh --init     # run the guided setup wizard, then deploy
#   bash scripts/install-service.sh uninstall  # stop + remove
#
# Self-host: everything operator-specific lives in ~/.walkie/config.json (see install-walkie.sh
# --init). The service reads it at start. The builder jail is OFF by default (builds use the
# operator's Claude subscription login); it's a hardened opt-in via cfg.jailProfile — the single
# source of truth, no plist env forcing it.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"            # walkie/conductor/scripts
CONDUCTOR="$(cd "$HERE/.." && pwd)"              # walkie/conductor — the ONLY anchor we rely on
RUN="$HOME/walkie-run"
PLIST="$HOME/Library/LaunchAgents/com.walkie.conductor.plist"
CONFIG="$HOME/.walkie/config.json"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  pkill -f 'src/run-live.mjs' 2>/dev/null || true
  pkill -f 'agent-relay-broker' 2>/dev/null || true
  echo "Walkie service uninstalled (mirror left at $RUN, config left at $CONFIG)."
  exit 0
fi

# --init: hand off to the guided wizard, which writes ~/.walkie/config.json AND calls back into
# this script to deploy. So we just run it and exit.
if [ "${1:-}" = "--init" ]; then
  exec bash "$HERE/install-walkie.sh"
fi

# Redeploy path: config must exist + be valid before we (re)load the service, so a broken config
# fails loudly here instead of crash-looping under launchd.
if [ ! -f "$CONFIG" ]; then
  echo "No config at $CONFIG. Run the guided setup first:  bash scripts/install-service.sh --init"
  exit 1
fi
WALKIE_CONFIG_PATH="$CONFIG" node --input-type=module -e '
  import { validateConfig } from "'"$CONDUCTOR"'/src/config.mjs";
  const v = validateConfig();
  if (!v.ok) { console.error("config incomplete — fix these in ~/.walkie/config.json (or re-run --init):"); for (const p of v.problems) console.error("  - " + p.key + ": " + p.message); process.exit(1); }
  console.log("config OK (" + (v.cfg.directorName||"Director") + "\x27s room, sandbox " + v.cfg.sandboxRepo + ")");
' || exit 1

echo "mirroring conductor → $RUN (outside Desktop/TCC)…"
mkdir -p "$RUN/walkie/conductor" "$RUN/walkie/team" "$RUN/brain/projects-kb/reports" "$RUN/brain/ideas" "$RUN/bin" "$HOME/.walkie" "$HOME/Library/LaunchAgents"
# Mirror the code + the jail shim's source (src/jail-profile.sh) + node_modules, straight from
# CONDUCTOR (this repo's conductor dir) — NOT reconstructed from a monorepo root. This works whether
# the repo is Paul's monorepo or a fresh standalone clone. Exclude the config template: the user
# owns ~/.walkie/config.json, the repo owns the template only.
# Build the source list from what actually exists: a checkout that hasn't run `npm i` (e.g. a
# repo worktree used only to redeploy) has no node_modules — the run dir keeps its own copy and
# the wizard path always installs deps first. A missing source must NOT abort the deploy: this
# script runs under set -e, and an rsync error here once killed the deploy BEFORE the service
# reload, leaving a stale process serving old code (the exact split-brain we've been killing).
SOURCES=("$CONDUCTOR/src" "$CONDUCTOR/scripts" "$CONDUCTOR/bin" "$CONDUCTOR/package.json")
[ -d "$CONDUCTOR/node_modules" ] && SOURCES+=("$CONDUCTOR/node_modules")
rsync -a --delete \
  --exclude 'config-template.json' \
  "${SOURCES[@]}" \
  "$RUN/walkie/conductor/"
# Deps must exist SOMEWHERE before the service boots: either just mirrored, or already in the
# run dir from a previous deploy. Refuse to reload a service that cannot start.
if [ ! -d "$RUN/walkie/conductor/node_modules" ]; then
  echo "no node_modules to run with — run 'npm i' in $CONDUCTOR (or the wizard) first."
  exit 1
fi

# Team personas: find them wherever they sit relative to the conductor — one level up in the
# monorepo (walkie/team), or bundled inside the conductor in a standalone clone (conductor/team).
TEAM_SRC=""
for cand in "$CONDUCTOR/../team" "$CONDUCTOR/team"; do
  [ -d "$cand" ] && TEAM_SRC="$(cd "$cand" && pwd)" && break
done
[ -n "$TEAM_SRC" ] && cp "$TEAM_SRC/"*.md "$RUN/walkie/team/" 2>/dev/null || true

# Optional factory "eyes" — Paul's monorepo only (brain/ two levels above the conductor). Absent
# in a standalone clone, and that's fine: factory.mjs returns an empty digest when they're missing.
BRAIN="$CONDUCTOR/../../brain"
[ -f "$BRAIN/projects-kb/reports/portfolio.md" ] && cp "$BRAIN/projects-kb/reports/portfolio.md" "$RUN/brain/projects-kb/reports/" 2>/dev/null || true
[ -f "$BRAIN/ideas/INDEX.md" ] && cp "$BRAIN/ideas/INDEX.md" "$RUN/brain/ideas/" 2>/dev/null || true

# Install the `claude` shim on the service PATH ($RUN/bin), FIRST in PATH so the harness resolves
# it before the real CLI. The shim relocates the jail-profile.sh call to $RUN/walkie/conductor/src.
cp "$CONDUCTOR/bin/claude" "$RUN/bin/claude"
chmod 755 "$RUN/bin/claude" "$RUN/walkie/conductor/src/jail-profile.sh" 2>/dev/null || true
echo "installed jailed 'claude' shim → $RUN/bin/claude"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.walkie.conductor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN/walkie/conductor/scripts/walkie-service.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$RUN/walkie/conductor</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/.walkie/conductor.log</string>
  <key>StandardErrorPath</key><string>$HOME/.walkie/conductor.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- \$RUN/bin FIRST so the harness resolves the jailed 'claude' shim before the real CLI. -->
    <key>PATH</key><string>$RUN/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <!-- NOTE: the jail is NOT set here. cfg.jailProfile in ~/.walkie/config.json is the single
         source of truth; run-live derives the jail state from it and the spawner injects
         WALKIE_PROFILE_DENY per-build. Forcing it in the plist is what caused the old
         split-brain (config said off, plist said on). Flip the config + reload this service. -->
    <key>WALKIE_STATE_DIR</key><string>$HOME/.walkie</string>
  </dict>
</dict>
</plist>
PLIST

pkill -f 'src/run-live.mjs' 2>/dev/null || true
pkill -f 'agent-relay-broker' 2>/dev/null || true
sleep 1
# Clear the broker's lock left behind by the process we just killed. Without this, the fresh
# broker refuses to start ("another broker instance is already running") and the phone has
# nothing on :3889 to talk to — a silent outage on every redeploy. The killed broker is gone
# (checked above), so the lock is stale by definition here.
rm -f "$HOME/.walkie/relay/broker-"*.lock 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Walkie service loaded (RunAtLoad + KeepAlive), running from $RUN. Logs: ~/.walkie/{conductor,broker}.log"
