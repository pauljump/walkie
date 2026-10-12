#!/bin/bash
# Install the Walkie bridge as a LaunchAgent (com.walkie.bridge) running from this checkout.
# Safe to re-run after `git pull`: it reinstalls dependencies and restarts the service.
# Unloads the Walkie 1.x conductor agent (com.walkie.conductor) first, since both use port 3889.
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.walkie.bridge.plist"
LOG_DIR="$HOME/Library/Logs/walkie"
mkdir -p "$LOG_DIR"
(cd "$MAC_DIR" && npm ci --omit=dev --silent)

if launchctl print "gui/$(id -u)/com.walkie.conductor" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.walkie.conductor" || true
  mv "$HOME/Library/LaunchAgents/com.walkie.conductor.plist" "$HOME/Library/LaunchAgents/com.walkie.conductor.plist.disabled" 2>/dev/null || true
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.walkie.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$MAC_DIR/src/cli.mjs</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>$MAC_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bridge.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/com.walkie.bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
curl -fsS "http://127.0.0.1:${WALKIE_PORT:-3889}/api/status" | grep -q '"version":3' && echo "Walkie bridge running on :${WALKIE_PORT:-3889}. Logs: $LOG_DIR/bridge.log"
