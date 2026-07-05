#!/bin/bash
# install-walkie.sh: the guided Walkie self-host installer.
#
# Walkie is a walking standup. You talk, your team builds, you review. All while you walk. It runs
# on YOUR Mac, not ours. Your keys, your code, your account. This wizard sets that up. Most of it I
# do for you. The goal is one thing: get you from "I just installed this" to "I talked and it
# built something" as fast as possible. Everything that can wait, waits.
#
# On your home wifi your phone and your Mac already find each other, so there is no relay and no VPN
# to set up first. Talk, watch it build. Add the walk-anywhere tunnel later, when you want it.
#
# Modes:
#   bash install-walkie.sh --check    dry-run: print every step's copy, detect what's there, install
#                                     NOTHING, open NOTHING, make NO paid calls. The $0 smoke test.
#   bash install-walkie.sh            guided setup: same steps, but it acts (installs deps, opens the
#                                     Claude login + the key page, writes ~/.walkie/config.json,
#                                     makes your scratch project, starts the room).
#   bash install-walkie.sh --help     this text
#
# It never commits, never touches your own repos, and never makes a paid LLM call during --check.
set -u

# ── Mode + paths ──────────────────────────────────────────────────────────────────────────────
MODE="run"
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) MODE="check" ;;
    --help|-h) MODE="help" ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"          # .../walkie/conductor/scripts
CONDUCTOR="$(cd "$HERE/.." && pwd)"            # .../walkie/conductor
WALKIE_HOME="$HOME/.walkie"
CONFIG="$WALKIE_HOME/config.json"
TEMPLATE="$CONDUCTOR/config-template.json"
SCRATCH_DIR="$HOME/walkie-scratch"             # the auto-created local practice project
SCRATCH_REMOTE="$WALKIE_HOME/scratch-origin.git"  # a local "origin" so builds can push + branch

# ── Little printers (no hype adjectives, short flat landings, reader is the hero) ───────────────
say()  { printf '%s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
copy() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()   { printf '  \033[33m•\033[0m %s\n' "$1"; }
act()  { [ "$MODE" = "check" ] && printf '  \033[2m(check) would: %s\033[0m\n' "$1" || printf '  → %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Build the one-tap pairing URL: walkie://pair?host=H&port=P&key=K, each value URL-encoded. The app
# (task #14) registers the `walkie` scheme and parses these exact param names into Settings. Node is
# guaranteed present by step 1, so we encode with node's encodeURIComponent — no extra tool needed.
pairing_url() { # pairing_url <host> <port> <key>
  W_H="$1" W_P="$2" W_K="$3" node --input-type=module -e '
    const enc = encodeURIComponent;
    const h = enc(process.env.W_H || ""), p = enc(process.env.W_P || ""), k = enc(process.env.W_K || "");
    process.stdout.write(`walkie://pair?host=${h}&port=${p}&key=${k}`);
  ' 2>/dev/null
}

# Print a scannable QR for a pairing URL, degrading to plain text with zero required deps. The URL
# holds your client key, so it is a credential — treat it like a password. In --check we render
# nothing real (install nothing, call nothing); we just state the intent.
print_pairing_qr() { # print_pairing_qr <url> <host> <port> <key>
  local __url="$1" __h="$2" __p="$3" __k="$4"
  if [ "$MODE" = "check" ]; then
    act "print a QR (or the pairing URL as text) for walkie://pair?host=…&port=…&key=…"
    copy "This code holds your client key. Treat it like a password. Only show it to your own phone."
    return
  fi
  if have qrencode; then
    qrencode -t ANSIUTF8 "$__url"
    copy "Scan that with your phone's camera and Walkie fills in the address and key for you."
  else
    copy "Pairing link (scan or paste into the app): $__url"
    copy "No QR tool installed (optional). Just open Walkie and it offers to fill this in, or type the"
    copy "address and key into Settings by hand: host=$__h port=$__p key=$__k"
    copy "Want a scannable code? Run: brew install qrencode, then re-run me."
  fi
  copy "This link holds your client key. Treat it like a password. Only show it to your own phone."
}

if [ "$MODE" = "help" ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Prompt helper: in --check we never read input, we just show the prompt copy.
ask() { # ask <var> <prompt> <default>
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  if [ "$MODE" = "check" ]; then
    copy "prompt: $__prompt${__default:+ [$__default]}"
    printf -v "$__var" '%s' "$__default"
    return
  fi
  read -r -p "  $__prompt${__default:+ [$__default]}: " __ans || true
  printf -v "$__var" '%s' "${__ans:-$__default}"
}

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 0 — Welcome
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "Walkie"
copy "Walkie is a walking standup. You talk, your team builds, you review. All while you walk."
copy "This runs on your Mac, not ours. Your keys, your code, your account. Nobody else in the room."
copy "This takes a few minutes. Most of it I do for you."
if [ "$MODE" = "check" ]; then
  copy "Check mode. I install nothing, I open nothing, and I make no paid calls."
else
  copy "Here we go."
fi

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 1 — Node (auto)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "1. Node"
copy "Node is the engine that runs the room and hands work to your team. It is a normal developer"
copy "tool. You do not touch it after this."
if have node; then
  ok "node $(node --version 2>/dev/null) is here. Nothing for you to do."
else
  no "node is not installed"
  act "install node for you (Homebrew, then brew install node)"
  if [ "$MODE" = "run" ]; then
    if have brew; then
      brew install node && ok "node is here."
    else
      copy "You do not have Homebrew, which is how I install Node. Get it at https://brew.sh, then"
      copy "run me again once. That is the only manual step Node needs."
      exit 1
    fi
  fi
fi

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 2 — Claude, the builder (auto install + auto-launch login)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "2. Claude, the builder"
copy "Your team is Claude working the command line. This is the part that writes the code. Signing"
copy "in here with your Claude subscription is what makes every build free. Flat, no meter."
if have claude; then
  ok "the Claude tool is here ($(command -v claude))"
else
  no "the Claude tool is not installed"
  act "install it for you (npm i -g @anthropic-ai/claude-code)"
  if [ "$MODE" = "run" ] && have npm; then npm i -g @anthropic-ai/claude-code || no "install reported a problem. See above."; fi
fi

# Is the subscription login already in the keychain? (read-only check, no paid call.)
CLAUDE_LOGGED_IN=0
if security find-generic-password -s "Claude Code" >/dev/null 2>&1 || security find-generic-password -l "Claude" >/dev/null 2>&1; then
  CLAUDE_LOGGED_IN=1
fi
if [ "$CLAUDE_LOGGED_IN" = "1" ]; then
  ok "a Claude login is in your keychain. Builds will run free."
else
  no "no Claude login yet"
  copy "A login opens now. Sign in with your normal Claude account, then come back here."
  # Only auto-launch on a real run in an interactive terminal. `claude /login` opens a browser and
  # blocks on you finishing the flow — fine in a terminal, but it would hang under CI or a pipe, so
  # we guard it on a TTY and never launch it in --check.
  if [ "$MODE" = "run" ] && [ -t 0 ] && have claude; then
    act "open the Claude login in your browser (claude /login)"
    claude /login || true
    # Re-check the keychain after the login flow returns.
    if security find-generic-password -s "Claude Code" >/dev/null 2>&1 || security find-generic-password -l "Claude" >/dev/null 2>&1; then
      CLAUDE_LOGGED_IN=1
      ok "a Claude login is in your keychain. Builds will run free."
    else
      no "still no login. Builds need it. Run 'claude /login' and re-run me."
    fi
  else
    act "open the Claude login in your browser (claude /login)"
    [ "$MODE" = "run" ] && copy "Not a normal terminal, so I did not launch it. Run 'claude /login' once, then re-run me."
  fi
fi

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 3 — The one key: the EM's voice (one-tap, console deep-link)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "3. The one key: the EM's voice"
copy "One voice talks to you on the walk. We call her the EM. She is the conversation, and she is"
copy "the magic, so she runs on a small metered key, not the subscription. Pennies per walk."
copy "Get the key here: https://console.anthropic.com/settings/keys"
copy "Click Create Key, copy it, paste it below. It starts with sk-ant."
copy "No account yet? Signing up is free; the key itself is usage-based. While you are on that page"
copy "you can set a spend cap so it can never surprise you. One line, optional, your call."
# Open the exact key page for them on a real run so they do not go hunting. Never in --check.
if [ "$MODE" = "run" ]; then
  have open && open "https://console.anthropic.com/settings/keys" >/dev/null 2>&1 || true
else
  act "open the Anthropic keys page (https://console.anthropic.com/settings/keys)"
fi
ANTHROPIC_KEY=""
ask ANTHROPIC_KEY "Paste your Anthropic API key (sk-ant-…), or leave blank to add it later in Settings" ""
if [ -n "$ANTHROPIC_KEY" ]; then
  case "$ANTHROPIC_KEY" in
    sk-ant-*) ok "key saved. It only runs the voice, nothing else." ;;
    *) no "that did not start with sk-ant-. Double-check it." ;;
  esac
else
  no "no key yet. The EM needs it to talk. Add it later in Settings and re-run."
fi

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 4 — A place to build (scratch repo, auto-create)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "4. A place to build"
copy "Your team needs a spot to put its work so you can review it. Think of it as a practice"
copy "notebook. Every build opens a change you can read. Nothing lands anywhere real."
copy "You do not have to pick anything. I make you a fresh scratch project on this Mac and use that."
copy "Point me at your own GitHub repo later in Settings when you want the team on real work."
if [ -d "$SCRATCH_DIR/.git" ]; then
  ok "your scratch project is already here ($SCRATCH_DIR)"
else
  act "make a scratch git project at $SCRATCH_DIR (a local practice notebook)"
  if [ "$MODE" = "run" ]; then
    # A local "origin" the builds can fetch + push to. The build path cuts a worktree off
    # origin/main and pushes the finished branch back; a local bare remote gives it exactly that,
    # with no GitHub account. There is no PR on this path (that turns on when you set a real repo in
    # Settings); the build lands as a readable branch on the Mac.
    mkdir -p "$WALKIE_HOME"
    if [ ! -d "$SCRATCH_REMOTE" ]; then git init --quiet --bare "$SCRATCH_REMOTE" || no "could not make the local remote"; fi
    if [ ! -d "$SCRATCH_DIR/.git" ]; then
      git init --quiet "$SCRATCH_DIR" 2>/dev/null || true
      ( cd "$SCRATCH_DIR" 2>/dev/null \
        && git symbolic-ref HEAD refs/heads/main 2>/dev/null \
        && [ ! -f README.md ] && printf '%s\n' "# walkie-scratch" "Your team's practice notebook. Every build is a branch you can read." > README.md \
        && git add -A \
        && git -c user.email=walkie@localhost -c user.name=Walkie commit -q -m "start the scratch project" \
        && git remote add origin "$SCRATCH_REMOTE" 2>/dev/null \
        && git push -q -u origin main 2>/dev/null ) || true
      [ -d "$SCRATCH_DIR/.git" ] && ok "made you a scratch project at $SCRATCH_DIR. Your team will build there for now." \
        || no "could not make the scratch project. Check that git is installed."
    fi
  fi
fi
# The one tiny question left, with a safe default so Enter moves on.
DIRECTOR_NAME=""
ask DIRECTOR_NAME "Your name (so the EM can address you)" "Director"

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 5 — Codex (deferred)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "5. Codex"
copy "Codex is the same idea from OpenAI, a second builder. You do not need it to start."
copy "Add it any time later: npm i -g @openai/codex && codex login"
no "skipping Codex for now."

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 6 — Write + check the config (auto)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "6. Write your config"
copy "Everything you just did lands in one file you own: $CONFIG. I write it and check it."
copy "No account and no middleman. On your wifi your phone talks straight to your Mac."
copy ""
copy "One honest disclosure: during the beta, Walkie sends anonymous usage COUNTS to the Walkie"
copy "team — install finished, service started, a build succeeded or not. Counts only, tied to a"
copy "random install id. NEVER your words, your prompts, your code, or your repo names."
copy "Turn it off any time: set \"telemetry\": false in $CONFIG."
if [ "$MODE" = "check" ]; then
  act "write $CONFIG (voice key=${ANTHROPIC_KEY:+set}${ANTHROPIC_KEY:-<blank>}, scratch=$SCRATCH_DIR, name=$DIRECTOR_NAME, jail=off, transport=local)"
else
  mkdir -p "$WALKIE_HOME"
  WALKIE_CONFIG_PATH="$CONFIG" \
  W_SDIR="$SCRATCH_DIR" W_DIR="$DIRECTOR_NAME" W_AK="$ANTHROPIC_KEY" \
  node --input-type=module -e '
    import { writeFileSync, existsSync, readFileSync } from "node:fs";
    import { randomBytes } from "node:crypto";
    const p = process.env.WALKIE_CONFIG_PATH;
    let base = {};
    if (existsSync(p)) { try { base = JSON.parse(readFileSync(p,"utf8")); } catch {} }
    // Per-user broker key: the secret the phone presents to reach THIS Mac (x-api-key). Mint a
    // unique one per install instead of the shared "br_walkie" default so one leaked/guessed key
    // cannot pair with every Walkie on the network. Only generated once; a re-run keeps the
    // existing key so an already-paired phone stays paired. NOT the shared default anymore.
    const brokerApiKey = base.brokerApiKey || ("br_" + randomBytes(16).toString("hex"));
    const cfg = {
      ...base,
      transport: base.transport || "local",
      workspaceKey: base.workspaceKey ?? null,           // not used on the local transport
      brokerApiKey,
      brokerBind: base.brokerBind || "0.0.0.0",
      brokerPort: base.brokerPort || "3889",
      brokerStateDir: base.brokerStateDir || "~/.walkie/relay",
      sandboxDir: process.env.W_SDIR || base.sandboxDir || "~/walkie-scratch",
      sandboxRepo: base.sandboxRepo ?? null,             // OPTIONAL: set in Settings to open PRs
      galleryDir: base.galleryDir || "~/walkie-demos",
      factoryRoot: base.factoryRoot ?? null,
      stateDir: base.stateDir || "~/.walkie",
      directorName: process.env.W_DIR || base.directorName || "Director",
      anthropicModel: base.anthropicModel || "claude-sonnet-4-6",
      anthropicApiKey: process.env.W_AK || base.anthropicApiKey || null,
      jailProfile: base.jailProfile ?? false,   // OFF by default: builds use your Claude subscription login (see step 7)
      telemetry: base.telemetry ?? true,        // beta counts, disclosed above; "telemetry": false turns it off
    };
    for (const k of Object.keys(cfg)) if (k.startsWith("_")) delete cfg[k];
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log("  wrote " + p);
  ' || no "could not write config"
  chmod 600 "$CONFIG" 2>/dev/null || true
fi

# Validate (both modes; no paid call).
if [ -f "$TEMPLATE" ] || true; then
  VALIDATE_PATH="$CONFIG"
  [ "$MODE" = "check" ] && [ ! -f "$CONFIG" ] && VALIDATE_PATH="/tmp/walkie-nonexistent-$$.json"
  WALKIE_CONFIG_PATH="$VALIDATE_PATH" node --input-type=module -e '
    import { validateConfig } from "'"$CONDUCTOR"'/src/config.mjs";
    const v = validateConfig();
    if (v.ok) console.log("  \x1b[32m✓\x1b[0m config is complete. You own that file.");
    else { console.log("  \x1b[33m•\x1b[0m still to set:"); for (const p of v.problems) console.log("    - " + p.key + ": " + p.message); }
  ' 2>/dev/null || no "config not written yet (expected in --check with no prior config)"
fi
[ -z "$ANTHROPIC_KEY" ] && [ "$MODE" = "run" ] && no "the voice key is still empty. Add it in Settings before you talk."

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 7 — Start the room (jailed) via the launchd service
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "7. Start the room"
copy "This boots the room on your Mac: the EM and your team, all local. No relay, no room key."
copy "I load it as a background service so it stays up. You do not keep a terminal open."
copy ""
copy "How the builders run — read this once:"
copy "  The team builds by running Claude Code on THIS Mac, signed in with YOUR Claude"
copy "  subscription. That is what keeps builds free. Because it is your own Mac and your own"
copy "  agent, it runs with your normal access while it works — the same trust you give Claude"
copy "  Code any time you run it by hand. Builds land in your scratch project ($SCRATCH_DIR)."
copy ""
copy "  Want it fenced in instead? There is a hardened mode (jail) that walls each build off from"
copy "  your files and secrets. It cannot use your subscription login, so it needs a paid API key."
copy "  Turn it on later: set \"jailProfile\": true and \"anthropicApiKey\" in $CONFIG, then reload."
if [ "$MODE" = "check" ]; then
  act "run install-service.sh to load the background service (LocalBus, subscription login, no relay)"
  ok "sandbox-exec is present ($(command -v sandbox-exec 2>/dev/null || echo missing)) — used only if you enable the jail"
else
  act "load the service"
  bash "$HERE/install-service.sh" && ok "Walkie is running on your Mac, pointed at your scratch project." \
    || no "service load reported a problem. See the message above."
fi

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 8 — Get the phone (one-tap)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "8. Get the phone"
copy "The app is how you talk on the walk."
copy "Install Walkie on your iPhone: open https://walkie.cc and tap the TestFlight link."
copy "Open it. On your home wifi it finds your Mac at the address below. Type it into the app's"
copy "Settings tab once, with the client key, and you are done."
# Prefer the .local hostname (stable across DHCP) as the primary; the LAN IP is the fallback.
BROKER_API_KEY="$(node --input-type=module -e '
  import { loadConfig } from "'"$CONDUCTOR"'/src/config.mjs";
  try { process.stdout.write(loadConfig({fresh:true}).brokerApiKey || "br_walkie"); } catch { process.stdout.write("br_walkie"); }
' 2>/dev/null || echo br_walkie)"
LOCAL_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
# Primary host for the QR, same priority the copy above uses: the .local name (stable on the LAN)
# first, then the LAN IP, then a placeholder for --check.
if [ -n "$LOCAL_NAME" ]; then
  PAIR_HOST="${LOCAL_NAME}.local"
elif [ -n "$LAN_IP" ]; then
  PAIR_HOST="$LAN_IP"
else
  PAIR_HOST="your-mac.local"
fi
if [ -n "$LOCAL_NAME" ]; then
  copy "Address on your wifi: ${LOCAL_NAME}.local:3889   client key: ${BROKER_API_KEY}"
  [ -n "$LAN_IP" ] && copy "If the name does not resolve, use the numbers: ${LAN_IP}:3889"
elif [ -n "$LAN_IP" ]; then
  copy "Address on your wifi: ${LAN_IP}:3889   client key: ${BROKER_API_KEY}"
  copy "(That number can change if your Mac reconnects. Re-find it with: ipconfig getifaddr en0)"
else
  copy "Address on your wifi: <your-mac>.local:3889   client key: ${BROKER_API_KEY}"
  copy "(Find your Mac's name with: scutil --get LocalHostName)"
fi
# One-tap pairing: scan this instead of typing the three fields above.
copy ""
copy "Or scan to pair in one tap:"
PAIR_URL_LAN="$(pairing_url "$PAIR_HOST" "3889" "$BROKER_API_KEY")"
print_pairing_qr "$PAIR_URL_LAN" "$PAIR_HOST" "3889" "$BROKER_API_KEY"

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 9 — Go
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "9. Go"
copy "Say the thing. Keep walking. Read the change when you are back."
copy "First time, try something small, like 'build me a page that says hello.' Watch it show up."
copy "That is the whole loop."

# ────────────────────────────────────────────────────────────────────────────────────────────────
# 10 — Tailscale, when you want the walk (optional)
# ────────────────────────────────────────────────────────────────────────────────────────────────
step "10. Tailscale, when you want the walk"
copy "You will be outside. Your Mac is at home. On your home wifi they already find each other, so"
copy "you do not need this yet. The moment you leave the house, your phone loses the Mac. Tailscale"
copy "is the private tunnel between them, so it keeps working anywhere, with nothing open to the world."
copy "Install the Tailscale app, sign in on your Mac and on your phone with the SAME account. Then in"
copy "the Walkie app swap the wifi address for your Mac's Tailscale name (like your-mac.tailXXXX.ts.net)."
copy "On the Mac: brew install --cask tailscale"
if have tailscale || [ -d "/Applications/Tailscale.app" ]; then
  ok "Tailscale is already installed on this Mac."
  if have tailscale && tailscale status >/dev/null 2>&1; then
    HOSTNAME_TS="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.Self&&j.Self.DNSName||"").replace(/\.$/,""))}catch{console.log("")}})' 2>/dev/null)"
    if [ -n "${HOSTNAME_TS:-}" ]; then
      ok "outside the house, use: ${HOSTNAME_TS}:3889   client key: ${BROKER_API_KEY}"
      copy "Or scan this one for the walk (works anywhere over Tailscale):"
      PAIR_URL_TS="$(pairing_url "$HOSTNAME_TS" "3889" "$BROKER_API_KEY")"
      print_pairing_qr "$PAIR_URL_TS" "$HOSTNAME_TS" "3889" "$BROKER_API_KEY"
    else
      no "Tailscale is installed but not signed in yet. Sign in when you want the walk."
    fi
  else
    no "Tailscale is installed but not signed in yet. Sign in when you want the walk."
  fi
else
  no "Tailscale is not installed. That is fine."
fi
copy "Skip it for now if you are just testing on your home wifi. Come back to this before your first"
copy "real walk."

if [ "$MODE" = "check" ]; then
  step "Dry run complete"
  copy "Nothing was installed. Nothing was opened. No calls were made. Run without --check to do it"
  copy "for real."
fi

# One anonymous "install finished" count (disclosed in step 6; counts only, never content).
# Runs only on a real install, only if the config says telemetry:true, and can never fail the
# installer — the whole thing is wrapped in || true with a short timeout.
if [ "$MODE" = "run" ]; then
  WALKIE_CONFIG_PATH="$CONFIG" node --input-type=module -e '
    import { loadConfig } from "'"$CONDUCTOR"'/src/config.mjs";
    import { instanceId } from "'"$CONDUCTOR"'/src/telemetry.mjs";
    const cfg = loadConfig();
    if (cfg.telemetry !== true || process.env.WALKIE_TELEMETRY === "0") process.exit(0);
    const body = JSON.stringify({ event: "install_done", property: "walkie-beta", path: "/install_done",
      props: { instance: instanceId(cfg.stateDir) } });
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 3000);
    await fetch("https://pulse.polyfeeds.dev/api/ingest", { method: "POST",
      headers: { "Content-Type": "text/plain" }, body, signal: ctrl.signal }).catch(() => {});
  ' 2>/dev/null || true
fi
