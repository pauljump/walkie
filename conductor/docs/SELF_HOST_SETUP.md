# Walkie self-host setup

Walkie is a walking standup. You talk, your team builds, you review. All while you walk. It runs on
your Mac, not ours. Your keys, your code, your account. Nobody else in the room.

This is the install runbook. The guided wizard does all of it for you; this doc is the map. The goal
is one thing: get you from "I just installed this" to "I talked and it built something" fast.
Everything that can wait, waits.

---

## Before you start

You need less than you think. On your home wifi your phone and your Mac already find each other, so
there is no relay and no VPN to set up first.

- macOS (10.15+). The builder jail uses `sandbox-exec`, which ships with macOS.
- Node. The wizard installs it if it is missing.
- The Claude tool, signed into your subscription. This is what makes the builds free. The wizard
  installs it and opens the login for you.
- An Anthropic API key (`sk-ant-…`) for the EM, the one voice that talks to you. Metered, pennies.
  The wizard opens the exact page and takes a one-line paste. Get it at
  https://console.anthropic.com/settings/keys (Create Key). No account yet? Signing up is free; the
  key itself is usage-based. On that page you can set a spend cap, one line, optional.

That is it to talk on your home wifi. Two things you do NOT need to start:

- **A GitHub repo.** The wizard makes you a local scratch project so the first walk works with no
  GitHub account. Point Walkie at your own repo later, in Settings, when you want PRs.
- **Tailscale.** You only need the tunnel to walk outside the house. Set it up later. See
  "Outside the house" below.

- Optional, any time: the Codex tool (the same idea, from OpenAI). Not needed to start.

### The one idea: two logins do two jobs

- **Builders = the `claude`/`codex` tool, signed into your subscription.** Flat. Free.
- **The EM = a small metered API key.** Pennies. It runs the conversation, and the conversation is
  the magic, so she gets her own key.

Your subscription does the heavy lifting for free, and a cheap key runs the voice. Now you have it.

---

## Quick start

```bash
bash scripts/install-service.sh --init
```

That runs the guided wizard. It installs Node and the Claude tool if they are missing, opens the
Claude login, opens the Anthropic key page for a one-line paste, makes your scratch project, writes
your config to `~/.walkie/config.json`, and starts the room on your Mac.

Want to see exactly what it will do without touching anything?

```bash
bash scripts/install-walkie.sh --check
```

`--check` is a full dry run. It prints every step, detects what is already there, installs nothing,
opens nothing, and makes no paid calls. Use it to smoke-test before you commit.

Redeploy after a code change (config unchanged):

```bash
bash scripts/install-service.sh
```

Stop it:

```bash
bash scripts/install-service.sh uninstall
```

---

## Your first build lands in the scratch project

You do not have to pick a repo to see it work. The wizard makes a local practice project at
`~/walkie-scratch` (a real git repo, its own local origin, no GitHub account). Every build the team
does lands there as a branch you can read on the Mac:

```bash
git -C ~/walkie-scratch log --oneline --all
git -C ~/walkie-scratch show <branch>
```

There is no pull request on this path, and the EM will not invent one. When you want the phone-side
review loop (open a PR, read it on your walk), set `sandboxRepo` to your own GitHub repo in
`~/.walkie/config.json`, then redeploy. That turns on the PR path.

---

## Config walkthrough: `~/.walkie/config.json`

You own this file. It is never mirrored back into the repo. Paths accept a leading `~`.

| Key | What it is |
|-----|-----------|
| `transport` | `local` (default) = a self-contained WS+REST bus on THIS Mac. No hosted relay, no room key. `agent-relay` = the original hosted path (needs `workspaceKey`). |
| `workspaceKey` | `rk_live_…`. Only used when `transport` is `agent-relay`. On the default `local` transport, leave it `null`. |
| `brokerApiKey` | `br_…`, the client key your phone presents to the local broker. Default `br_walkie`. |
| `brokerBind` | Bind address. `0.0.0.0` lets your phone reach it over wifi and, later, Tailscale. |
| `brokerPort` | Port the broker serves on. Default `3889`. |
| `brokerStateDir` | Broker state. Out-of-repo so a sync can't wipe it. |
| `sandboxDir` | Where the builders work. The wizard auto-creates `~/walkie-scratch` here. |
| `sandboxRepo` | **Optional.** `owner/repo`, YOUR GitHub repo. `null` = builds stay local in the scratch project. Set it to open PRs. |
| `galleryDir` | Where published web demos are staged. |
| `factoryRoot` | Optional. A monorepo/portfolio root so the EM can see your projects. `null` = none. |
| `stateDir` | Root for logs, cost meter, team memory. Default `~/.walkie`. |
| `directorName` | What the EM calls you. |
| `anthropicModel` | Model the EM runs on. Default `claude-sonnet-4-6`. |
| `anthropicApiKey` | `sk-ant-…` for the EM. A key, not a login. Builders don't use it. |
| `jailProfile` | `false` by default: builders use your Claude subscription login (free, works first try). `true` = a hardened `sandbox-exec` jail, which also blocks the login, so it then requires a metered `anthropicApiKey`. See "the builder jail" below. |
| `demoHost` / `galleryHost` | Optional public hosts for shipped web demos. `null` = local-only (no live URL). |
| `transcripts` | `true` by default: your walks are saved to `~/.walkie/transcripts/` (daily JSONL, voice line + team room, build noise skipped). Local only. `false` = keep nothing. |

Every field also has a `WALKIE_*` environment override (for CI/testing). The file is the norm for
self-host, env wins when set. See `config-template.json` for the annotated defaults.

Example (the local self-host default: no room key, local scratch, PRs off):

```json
{
  "transport": "local",
  "workspaceKey": null,
  "brokerApiKey": "br_alex",
  "brokerBind": "0.0.0.0",
  "brokerPort": "3889",
  "brokerStateDir": "~/.walkie/relay",
  "sandboxDir": "~/walkie-scratch",
  "sandboxRepo": null,
  "galleryDir": "~/walkie-demos",
  "factoryRoot": null,
  "stateDir": "~/.walkie",
  "directorName": "Alex",
  "anthropicModel": "claude-sonnet-4-6",
  "anthropicApiKey": "sk-ant-xxxxxxxxxxxxxxxx",
  "jailProfile": false
}
```

To open PRs on your own repo instead of the scratch project, set `sandboxRepo` to `owner/repo`,
clone it into `sandboxDir`, and redeploy.

---

## Security: the builder jail (opt-in)

Your builders run Claude Code on your Mac to write code. **By default the jail is OFF**
(`jailProfile: false`): a build runs with your normal access and signs in with your Claude
subscription, so it's free and works on the first try. This is the same trust you already extend
every time you run Claude Code by hand — it's your Mac and your own agent.

If you'd rather fence each build in, set `jailProfile: true`. That wraps every builder in a
`sandbox-exec` profile:

- **Blocked:** `~/.secrets`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/Library/Keychains`,
  `~/Desktop`, `~/Documents`, `/var/db`.
- **Writable:** only the task's worktree, `~/.walkie`, and temp.
- **Open:** network (builders reach GitHub and the Anthropic API).

**The catch:** the jail also blocks the login keychain, so a jailed builder **cannot** use your
subscription login — it would fail `Not logged in`. So if you turn the jail on, you must also set a
metered `anthropicApiKey` (`sk-ant-…`); the builders bill against that key instead of your flat
subscription. That's the trade: a hardened fence for a per-build API cost.

`jailProfile` is the single source of truth (no plist env forces it) — flip it in your config and
redeploy (`bash scripts/install-service.sh`) and it takes effect. Full design + how to test the
profile: `JAIL_PROFILE.md`.

---

## Get the phone

Install the Walkie app: open <https://walkie.cc> on your iPhone and tap the TestFlight link.

Open it. On your home wifi it finds your Mac at your Mac's `.local` name plus the broker port (e.g.
`your-mac.local:3889`), with the client key from your config (`brokerApiKey`). Type that into the
app's Settings tab once. The wizard prints the exact address and key at the end.

Find them again any time:

```bash
scutil --get LocalHostName    # your Mac's name → <name>.local
ipconfig getifaddr en0        # the numeric wifi address, if the name doesn't resolve
```

The voice defaults to the robot voice, which is fine for the first walk. Bring-your-own or premium
voice is a later choice in the app's Settings.

---

## Outside the house: Tailscale (optional)

You will be outside. Your Mac is at home. On your home wifi they already find each other, so you do
not need this yet. The moment you leave the house, your phone loses the Mac. Tailscale is the private
tunnel between them, so it keeps working anywhere, with nothing open to the world.

1. Install the Tailscale app: `brew install --cask tailscale` on the Mac, the App Store on the phone.
2. Sign in on your Mac and on your phone with the SAME account.
3. In the Walkie app, swap the wifi address for your Mac's Tailscale name (looks like
   `your-mac.tailXXXX.ts.net`). Keep the same port and client key.

Skip it for now if you are just testing on your home wifi. Come back to this before your first real
walk.

---

## Troubleshooting

- **Logs:** `~/.walkie/conductor.log` (the EM + team). The conductor log states the transport
  (`transport: local`) and `jailed workers enabled` or `jail OFF` at startup.
- **Cost meter:** `~/.walkie/usage.json` (talkers only; builders are subscription-flat).
- **"no config" on start:** run `bash scripts/install-service.sh --init`.
- **"config incomplete":** the service prints which key is missing. Fix `~/.walkie/config.json` or
  re-run `--init`.
- **No voice on the first walk:** the EM key is blank. Add `anthropicApiKey` (`sk-ant-…`) to
  `~/.walkie/config.json` or re-run `--init`, then redeploy.
- **Builds can't write:** the jail allows temp + the task worktree; the scratch project lives under
  `~/walkie-scratch`, which the jail permits. A custom `sandboxDir` outside temp needs to be a real
  path the jail allows.
- **Builders not logged in:** run `claude /login` once. The keychain login is read-only inside the
  jail, so it just works after that.
- **Nothing on the phone:** on home wifi, confirm the address (`scutil --get LocalHostName`) and that
  the broker is listening on `:3889`. Outside the house, confirm Tailscale is up on both devices
  (`tailscale status`).
