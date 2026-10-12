# Walkie: the product (decided 2026-10-11)

One line: **the client for people who pay for more than one AI coding subscription.** Claude Code,
Codex, Antigravity and Grok, on your Mac, on your logins, in one native iPhone app.

## Why this wedge

| Who | What they ship | What they will never ship |
|---|---|---|
| Anthropic | Remote Control in the Claude app (research preview since Feb 2026; phone can start sessions since Aug 2026); push when a session needs you; Pro/Max only | A window into Codex, Antigravity or Grok |
| OpenAI | Codex inside the ChatGPT app (preview May 2026): approve, steer, switch models, start threads; secure relay | A window into Claude Code |
| Happy, Paseo, ccpocket | Free, open-source wrappers around Claude Code and Codex with E2E relays | Taste. They compete on breadth and price ($0). |

The platforms are structurally unable to be neutral, and the free clients have no reason to be
elegant. The person who pays for two or more plans is real and growing: weekly limits on Claude
Code, Plus users running out of Codex in hours, and every guide's advice being "switch tools when
you're rate-limited". Nobody serves that switch.

## What makes it the one

- **Elegance:** one screen. Meters, what needs you, every conversation. Nothing else.
- **Scalability:** from one project to a hundred, from one session to ten at once. Lists are the
  CLIs' own records, so there's nothing to migrate. *Send to projects* turns one planning
  conversation into one session per project.
- **Reliability as a feature:** outbox, exactly-once sends, ping/pong, CLIs that crash without
  taking anything down. The platform apps are allowed to be flaky; a client people pay for isn't.
- **Only a multi-subscription client can do:** meters for every plan read without spending quota;
  continue a conversation on another plan when one runs out; pick a model per project from any plan.

## Personalization: your agents customize Walkie

Walkie never grows a settings screen for this. `~/.walkie/walkie.json` is a small documented
contract, and any of your agents can edit it when you ask ("add a Walkie quick ask for this
project that runs the tests"). Today's fields: quick asks (global and per project) and project
display names. Because the editor is an agent, personalization is unbounded without a UI. The
skill that teaches agents the contract ships with the bridge (`mac/skill/SKILL.md`).

## Money

- **Free:** one subscription. Everything Walkie does, for the first CLI you use.
- **Walkie for all subscriptions: $29.99, once.** Every CLI, continue elsewhere across plans, send
  to projects across plans. Non-consumable in-app purchase `cc.walkie.all`.

Why one-time: the customer already pays $20–$400 a month in subscriptions. A subscription for the
client is resentment; a one-time price "less than one month of what you already pay" is a relief.
Why gate on the second subscription and not on features: the gate *is* the thesis.

Reliability over revenue: when the store can't be reached and nothing is cached, Walkie is
unlocked. Nobody gets locked out of their own Mac by a StoreKit outage, and until the product
exists in App Store Connect the gate is invisible.

Later, not now: a hosted relay for reaching your Mac off the tailnet and for several Macs
(subscription, because it costs us per month).

## Distribution

- iPhone app on the App Store (`cc.walkie.app`, App Store Connect 6787685702). Reviewers have no
  Mac, so the app ships a built-in demo (Pair screen → "See it work").
- Mac bridge: open source at github.com/pauljump/walkie, `curl -fsSL https://walkie.cc/install.sh | bash`.
- walkie.cc: the pitch, the install, support and privacy.

## Not doing

Threads, leads, voice walks, portfolio tools, a web app, Android, Windows bridges, cloud sessions.
The archive tag `archive/v2-everything` holds the first five if they're ever wanted back.
