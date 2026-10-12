#!/bin/bash
# Walkie: the Mac side. Fetched by:  curl -fsSL https://walkie.cc/install.sh | bash
#
# What this does, in order (nothing hidden):
#   1. Checks for macOS, node 20+, npm and git.
#   2. Clones github.com/pauljump/walkie to ~/walkie (or updates it if it's already there).
#   3. Installs the bridge's dependencies and a LaunchAgent (com.walkie.bridge) on port 3889.
#   4. Prints the pairing link and QR code for the Walkie iPhone app.
#
# The bridge drives the CLIs you already have (claude, codex, agy, grok) on your own logins. It
# never uses API keys. Your pairing key lives in ~/.walkie/key and never leaves your Mac.
set -euo pipefail

REPO="${WALKIE_REPO:-https://github.com/pauljump/walkie.git}"
DEST="${WALKIE_HOME_DIR:-$HOME/walkie}"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

say "Walkie: setting up your Mac."
[ "$(uname -s)" = "Darwin" ] || die "The Walkie bridge runs on macOS (this is $(uname -s))."
command -v node >/dev/null 2>&1 || die "node is missing. Install it (brew install node) and re-run."
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR is too old; Walkie needs node 20+."
command -v npm >/dev/null 2>&1 || die "npm is missing (it normally ships with node)."
command -v git >/dev/null 2>&1 || die "git is missing. Run: xcode-select --install, then re-run."
note "node $(node -v), npm, git ✓"
FOUND=""
for cli in claude codex agy grok; do command -v "$cli" >/dev/null 2>&1 && FOUND="$FOUND $cli"; done
if [ -n "$FOUND" ]; then note "agents on this Mac:$FOUND"; else note "no agent CLIs found yet (claude, codex, agy, grok). Walkie will list them as you install them."; fi

say "Getting the bridge…"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only -q && note "updated $DEST"
else
  git clone -q "$REPO" "$DEST" && note "cloned to $DEST"
fi

say "Installing the service…"
"$DEST/mac/scripts/install-service.sh"

say "Pair your phone."
( cd "$DEST/mac" && node src/cli.mjs pair )
note "Get Walkie for iPhone at https://walkie.cc. Re-run this script any time to update."
