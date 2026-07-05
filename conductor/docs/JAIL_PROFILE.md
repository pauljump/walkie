# The builder jail — technical design

Walkie is self-host: the backend runs on the operator's own Mac. Builders are `claude`/`codex` CLI
processes that write real code. Unjailed, a builder can read the operator's `~/.ssh`, `~/.aws`,
`~/.secrets`, keychains — everything. The jail confines them: their secrets are blocked, but the
builder still runs, still uses the operator's own subscription login, and writes only in the sandbox.

## Why `sandbox-exec` (seatbelt)

macOS ships `sandbox-exec` (the seatbelt sandbox) at `/usr/bin/sandbox-exec`. It is the same
mechanism the App Store sandbox is built on — a mature, kernel-enforced, deny-by-default policy
language (SBPL). No third-party dependency, no container, no VM. It wraps a process and filters its
syscalls against a profile. That is exactly the shape we need: confine one child process (`claude`)
without touching the rest of the machine.

## Profile structure

`src/jail-profile.sh <worker> <sandbox-dir> [state-dir]` generates a profile to
`/tmp/walkie-<worker>.sb` and prints its path. Structure:

```
(version 1)
(deny default)                 ;; deny-by-default — the whole security model

(allow process-fork)           ;; the builder must run, fork, exec its toolchain
(allow process-exec)
(allow mach-lookup)            ;; system frameworks + securityd (keychain)

(allow file-read*)             ;; broad read so tools resolve …
(deny  file-read* file-write*  ;; … EXCEPT the secrets (a later deny overrides the allow)
  (subpath "~/.secrets") (subpath "~/.ssh") (subpath "~/.aws")
  (subpath "~/.gnupg")   (subpath "~/.config") (subpath "~/Library/Keychains")
  (subpath "~/Desktop")  (subpath "~/Documents") (subpath "/var/db") …)

(allow mach-lookup (global-name "com.apple.securityd") …)  ;; keychain read via securityd IPC

(allow file-write* (subpath "<sandbox-dir>"))   ;; write ONLY the task worktree …
(allow file-write* (subpath "<state-dir>"))     ;; … Walkie state …
(allow file-write* (subpath "<TMPDIR>"))        ;; … and temp (worktrees live here)

(allow network*)               ;; reach Relaycast, GitHub, the Anthropic API
```

SBPL evaluates rules in order; a later rule wins. So the broad `(allow file-read*)` makes normal
tools work, and the explicit `(deny … secrets)` after it carves the holes back out. Reads are broad,
writes are a tiny allow-list.

## What's blocked, and why

The deny-set is the proven one: `~/.secrets`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config` (Chrome
profiles, tool creds), `~/Library/Keychains` (raw keychain files), `~/Desktop`, `~/Documents`, and
`/var/db` (system data). These are the operator's private material. A builder has no reason to touch
them; the jail makes sure it can't, even if a prompt or a dependency tries.

Writes are confined to the task's worktree, `~/.walkie`, and temp. A builder cannot modify anything
else on the machine — not its own toolchain, not the operator's dotfiles, not another task's tree.

## What's allowed, and why

- **System binaries + frameworks** (`/usr/bin`, `/opt/homebrew`, `/Library/Frameworks`): read-only,
  so `git`, `node`, `gh`, and `claude` itself resolve and run.
- **The subscription login** (keychain, read-only via securityd IPC): the operator ran `claude
  login` once; the token sits in the login keychain. The jail allows read-only keychain *lookups*
  (the securityd mach service) so the builder authenticates as the operator — flat, free — while the
  raw `~/Library/Keychains` files stay blocked so the credential can't be copied out. No
  `keychain-write`, so a builder can't poison the stored credential.
- **Network**: open. Builders reach Relaycast (the room), GitHub (push branches), and the Anthropic
  API. No TLS interception.

## The injection point — a `claude` shim on PATH

The harness spawns builders as `claude …` via a PTY. The installer puts a shim at `$RUN/bin/claude`
and prepends `$RUN/bin` to the service PATH, so macOS resolves `claude` to the shim first. The shim
(`bin/claude`):

1. resolves the REAL claude (skipping its own dir so it never recurses),
2. if `WALKIE_PROFILE_DENY=1`, generates the per-worker profile (`jail-profile.sh`),
3. `exec sandbox-exec -f <profile> <real-claude> "$@"`.

With `WALKIE_PROFILE_DENY` unset/`0` it passes straight through to the real claude (dev on a trusted
machine). The launchd plist sets `WALKIE_PROFILE_DENY=1`, so the live service is always jailed.

Worktrees always live under the temp dir (`workspace.mjs` uses `tmpdir()`), which the profile allows
wholesale — so a builder can always write its own task tree regardless of parallel-dispatch timing.
The per-worker `WALKIE_SANDBOX_DIR` is an extra, belt-and-suspenders allow, not the load-bearing one.

`bin/claude-wrapper-stub.sh` is the teaching version of the shim — a minimal, annotated example you
can run by hand to see the flow.

## Testing + debugging

Generate and enforce a profile by hand:

```bash
prof=$(bash src/jail-profile.sh Test /tmp/walkie-test-sandbox ~/.walkie)
sandbox-exec -f "$prof" /bin/cat /etc/hosts        # allowed read → works
sandbox-exec -f "$prof" /bin/ls  ~/.ssh            # blocked → "Operation not permitted"
sandbox-exec -f "$prof" /usr/bin/touch ~/Desktop/x # blocked → "Operation not permitted"
sandbox-exec -f "$prof" /usr/bin/touch /tmp/walkie-test-sandbox/x  # allowed → works
sandbox-exec -f "$prof" /usr/bin/security list-keychains          # allowed (read-only) → works
```

Debug denials: `sandbox-exec -D -f <profile> <cmd>` reports violations; they also go to the system
log (`log stream --predicate 'sender == "Sandbox"'`).

Prove the shim wiring without the harness (use any binary as the "real claude"):

```bash
WALKIE_REAL_CLAUDE=/bin/ls WALKIE_PROFILE_DENY=1 WALKIE_WORKER_NAME=demo \
  WALKIE_SANDBOX_DIR=/tmp/walkie-test-sandbox bash bin/claude ~/.ssh   # → denied
```

## Known limits

- **Network** is open (builders need it); there is no TLS interception or egress allow-list.
- **CPU / memory / file descriptors** are not capped by the profile; launchd doesn't cap individual
  child processes. Concurrency is bounded by the operator's subscription rate limit and the Mac.
- **TCC / privacy** (Microphone, Camera, etc.): `sandbox-exec` runs as the user and inherits the
  same TCC grants launchd already has — the jail neither adds nor removes those. Not relevant for a
  CLI builder.
- The jail protects the operator from their *own* builders. It is not a defense against a malicious
  operator; on self-host, the operator owns the machine.
