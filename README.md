# Walkie

**Jam on a walk. Ship real work.**

Walkie is a phone call with Mara. You think out loud on a walk. She runs a team of AI engineers building on your own Mac, and real pull requests land while you're still walking. You just jam.

Everything runs on machines you own. No account, no middleman, and no key ever leaves your Mac. This repo is the whole thing: the Mac backend and the iOS app, published so you can verify that for yourself, and so you can clone it and make it yours.

**Try it:** [walkie.cc](https://walkie.cc)

## How it's shaped

- **You** talk to exactly one voice: **Mara**, the engineering manager. She pushes back, scopes the idea, and coordinates the whole team. Nothing starts until you say go.
- **The team** (Theo, Cora, Nia) are role agents who build with **Claude Code** on your Mac, using your own Claude subscription sign-in. Builds run in the background and in parallel while you keep talking.
- **Everything lands as a pull request** (or a local branch in scratch mode). You review the diff on your phone and merge what's good.
- **The phone talks straight to your Mac** over your wifi (or Tailscale when you're out) via a small local WS+REST bus. No hosted anything.

```
iPhone (Walkie app)  ── LAN / Tailscale ──►  your Mac
                                             ├─ LocalBus (:3889)
                                             ├─ Mara (the EM mind)
                                             └─ builders = Claude Code, one-shot, per task
```

## Layout

| Path | What |
|------|------|
| `conductor/` | The Mac backend: LocalBus, Mara, the team room, the builder spawner, the guided installer |
| `team/` | The engineers' personas |
| `ios/` | The SwiftUI iPhone app (XcodeGen project) |

## Self-host it

The friendly path is the one-liner at [walkie.cc](https://walkie.cc). By hand:

```bash
cd conductor
npm install
bash scripts/install-service.sh --init   # guided setup: config, background service, pairing QR
```

You'll need macOS, node 20+, git, and the `claude` CLI signed in (Claude Pro or Max). The wizard writes one config file you own (`~/.walkie/config.json`), starts a background service, and prints the QR you scan with the app.

Build the app yourself:

```bash
cd ios
xcodegen generate
xcodebuild -scheme Walkie -sdk iphonesimulator build
```

For a device build, set your own Apple Team in `ios/project.yml` (`DEVELOPMENT_TEAM`) or let Xcode manage signing.

## Honesty notes

- **Your words stay yours.** Nothing you say or build leaves your machines. During the beta the backend sends anonymous usage *counts* (install finished, a build succeeded or not, tied to a random install id, never content), disclosed at install time. Off switch: `"telemetry": false` in `~/.walkie/config.json`.
- **Builders run unconfined by default** so they can use your Claude sign-in, the same trust you give Claude Code by hand. A hardened sandbox mode exists (`jailProfile: true`) and requires a metered API key. See `conductor/docs/SELF_HOST_SETUP.md`.
- **Clone it, fork it, or ask your own AI to build you one.** All fine. Ours keeps growing; yours is yours.

MIT licensed.
