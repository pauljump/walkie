# Walkie

**Every AI coding subscription you pay for, in one iPhone app.**

Claude Code, Codex, Antigravity and Grok run on your Mac, on your own logins. Walkie is the phone
in front of them: one native chat for all of them, meters for every plan, and the two things only a
multi-subscription client can do: continue a conversation on another plan when one runs out, and
turn one planning conversation into one session per project.

- App: [walkie.cc](https://walkie.cc) (App Store; free for one subscription, $9.99 once for all of them)
- Build it yourself, free: [the exact prompt](docs/BUILD-IT-YOURSELF.md) ([walkie.cc/build](https://walkie.cc/build))
- Mac bridge (this repo, `mac/`): `curl -fsSL https://walkie.cc/install.sh | bash`

Everything runs on machines you own. The phone reaches the Mac over your private network (Tailscale
or Wi-Fi) with one shared key the bridge makes. There is no account and no server of ours, and the
bridge strips API keys from its environment so the CLIs always run on your subscriptions.

## What's here

| Path | What |
|---|---|
| `mac/` | The bridge: a small Node server that drives the real CLIs (`claude` via the Agent SDK, `codex app-server`, `agy -p`, `grok agent stdio`). `npm test` runs its suite. |
| `mac/skill/` | A skill any agent can read to customize Walkie through `~/.walkie/walkie.json`. |
| `ios/` | The SwiftUI app. `xcodegen generate`, set your team in `project.yml`, open `Walkie.xcodeproj`. |
| `docs/PRODUCT.md` | Why Walkie is shaped this way, and what it will not become. |
| `docs/BUILD-IT-YOURSELF.md` | The one-run agent prompt that builds Walkie from scratch. |
| `docs/SYNC.md` | How Walkie stays in sync with each CLI's own records. |
| `install.sh` | What `walkie.cc/install.sh` serves. |

## Run the bridge by hand

```bash
cd mac
npm install
npm test
./scripts/install-service.sh     # LaunchAgent com.walkie.bridge on :3889
node src/cli.mjs pair            # the walkie://pair link + QR for the phone
```

Options (env): `WALKIE_PORT` (3889), `WALKIE_BIND` (0.0.0.0), `WALKIE_PROJECT_ROOTS` (colon-separated
folders whose git repos become the project list; default `~/projects`), `WALKIE_BROKER_API_KEY`
(else `~/.walkie/key`, made on first run).

## Reliability

- Messages go through an outbox on the phone: they show at once, send when the Mac is reachable,
  and run exactly once.
- The phone pings the bridge; a socket that stops answering is replaced, and reconnecting catches
  up every open conversation.
- A CLI that is missing, hangs or crashes never takes the bridge down. Its calls fail with a reason
  you can act on, and the next call starts it fresh.

## License

MIT. Walkie is not affiliated with Anthropic, OpenAI, Google or xAI.
