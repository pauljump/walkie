#!/bin/bash
# Walkie builder jail — generate a macOS sandbox-exec (seatbelt) profile for ONE worker.
#
# Walkie is self-host: the backend runs on the operator's OWN Mac. A builder is a `claude`/`codex`
# CLI process the harness spawns to write code. Without a jail it can read the operator's ~/.ssh,
# ~/.aws, ~/.secrets, keychains — everything. This profile is deny-by-default: it blocks the
# operator's secrets but still lets the builder (1) run, (2) use the operator's OWN subscription
# login (keychain, read-only) so builds stay flat/free, and (3) write ONLY inside the sandbox.
#
# Usage:
#   jail-profile.sh <worker-name> <sandbox-dir> [state-dir]
#     worker-name  label for the profile file (e.g. TheoHands0001)
#     sandbox-dir  the writeable build dir (the task's worktree; e.g. /tmp/walkie-build-xyz)
#     state-dir    Walkie state, also writeable (default ~/.walkie)
#
# Prints the path to the generated profile on stdout (the `claude` shim reads this). The profile
# is written to /tmp/walkie-<worker>.sb — regenerated each dispatch so it always matches the
# current task dir + config.
#
# Debug a profile:  sandbox-exec -D -f <profile> <cmd>   (denials go to the system log)
set -u

worker="${1:-worker}"
sandbox_dir="${2:-}"
state_dir="${3:-$HOME/.walkie}"

# Sanitize the worker name for a filename (no path traversal, no spaces).
safe_worker="$(printf '%s' "$worker" | tr -c 'A-Za-z0-9_-' '_')"
profile="/tmp/walkie-${safe_worker}.sb"

# TMPDIR on macOS is a per-user path under /var/folders; builders need it for scratch files.
tmp_root="${TMPDIR:-/tmp}"
# strip trailing slash for clean subpath rules
tmp_root="${tmp_root%/}"

# Emit an (allow file-write* (subpath "…")) line only if the path is non-empty.
write_subpath() {
  [ -n "$1" ] && printf '  (allow file-write* (subpath "%s"))\n' "$1"
}

cat > "$profile" <<PROFILE
(version 1)
;; Walkie builder jail for worker: ${worker}
;; deny-by-default; explicit allows below. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
(deny default)

;; ── Process: the builder must run, fork, and exec its toolchain (git, node, gh, claude). ──
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)   ;; needed for security(1)/Keychain + system frameworks

;; ── Read: broad read of the system + the user's non-secret tree, so tools resolve. ──
;; We deny the SECRET subpaths explicitly below; a later deny overrides this allow.
(allow file-read*)
(allow file-read-metadata)

;; ── DENY the operator's secrets (read AND write). The whole point of the jail. ──
(deny file-read* file-write*
  (subpath "${HOME}/.secrets")
  (subpath "${HOME}/.ssh")
  (subpath "${HOME}/.aws")
  (subpath "${HOME}/.gnupg")
  (subpath "${HOME}/.config")
  (subpath "${HOME}/.docker")
  (subpath "${HOME}/.kube")
  (subpath "${HOME}/.npmrc")
  (subpath "${HOME}/Library/Keychains")
  (subpath "${HOME}/Desktop")
  (subpath "${HOME}/Documents")
  (subpath "/Library/Keychains")
  (subpath "/var/db"))

;; ── Keychain: allow READ-ONLY of the login keychain so the builder can use the operator's
;; OWN claude/codex subscription token (from a one-time CLI login). We do NOT allow
;; keychain-write, so a builder cannot poison or overwrite the stored credential. The broad
;; file-read* above plus mach-lookup to securityd is what makes the security(1) lookup
;; work; the Keychains DENY above still blocks the raw keychain FILES from being copied out,
;; while the securityd IPC path (read-only lookups) stays open. ──
(allow mach-lookup (global-name "com.apple.SecurityServer"))
(allow mach-lookup (global-name "com.apple.securityd"))
(allow mach-lookup (global-name "com.apple.trustd"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.api"))
(allow authorization-right-obtain)

;; ── Write: ONLY the sandbox (the task's worktree) + Walkie state + temp. Nothing else. ──
$(write_subpath "${sandbox_dir}")
$(write_subpath "${state_dir}")
  (allow file-write* (subpath "${tmp_root}"))
  (allow file-write* (subpath "/private/tmp"))
  (allow file-write* (subpath "/tmp"))
  (allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))
  (allow file-write* (subpath "/dev/fd"))

;; ── Network: builders reach Relaycast, GitHub, and the Anthropic API. No interception. ──
(allow network*)

;; ── IPC / misc the CLI needs. ──
(allow ipc-posix-shm)
(allow iokit-open)
PROFILE

echo "$profile"
