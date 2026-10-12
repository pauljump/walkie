# Build your own Walkie

Walkie costs $9.99 once. You don't have to pay it. Everything Walkie does fits in one long agent
run, and this is the exact prompt. Paste it into Claude Code (or Codex) on your Mac in an empty
folder, on the strongest model you have, and let it work. Expect a few hours and a good chunk of a
weekly limit. You'll need Xcode and an Apple Developer account to put the app on your phone.

What the $9.99 buys instead: someone who uses this every day keeps building it, cutting what
doesn't earn its place, fixing what breaks when a CLI changes, and shipping updates to your phone.
You can build it. The point is that you don't have to keep building it.

(The source of the real thing is also public, MIT, at github.com/pauljump/walkie.)

---

## The prompt

```text
Build me "Walkie": an iPhone app plus a small Mac server that lets me use every AI coding CLI I
pay for (Claude Code, Codex, Antigravity, Grok) from my phone, on my own Mac and my own logins.
Work autonomously until everything under "Done when" is true. Ask me only for things only I can
do (Apple sign-in, physically installing on my phone).

GOAL
One native chat for all my coding agents. Simplicity and reliability are the two bars. If a
feature doesn't serve "talk to my agents from my phone" or "use all my subscriptions well", leave
it out.

ARCHITECTURE
- mac/: a Node 20+ server ("the bridge"), ESM, minimal dependencies (the Claude Agent SDK and ws).
  It drives the real CLIs:
  - Claude Code through @anthropic-ai/claude-agent-sdk in streaming-input mode. Choose the session
    UUID yourself (sessionId option) so the phone has a stable key before the CLI starts. Map
    canUseTool to permission cards and AskUserQuestion to question cards. List and read history
    with the SDK's listSessions/getSessionMessages; rename and archive with renameSession/tagSession.
    Which sessions are running comes from `claude agents --json`.
  - Codex through one long-lived `codex app-server` (JSON-RPC over stdio). thread/list MUST pass
    useStateDbOnly: true (otherwise it rescans every rollout file and takes ~45s). History through
    thread/turns/list, paged. Approvals (item/commandExecution/requestApproval,
    item/fileChange/requestApproval) and item/tool/requestUserInput become cards. Steer a running
    turn with turn/steer. Commands run as `/bin/zsh -lc '<cmd>'`; strip that wrapper for display.
    Read lines with a size cap so one giant history line can't crash the process.
  - Grok through ACP: `grok agent stdio` (session/new, session/prompt, session/load replays
    history, session/request_permission becomes a card).
  - Antigravity through `agy -p <text> --output-format stream-json [--conversation <id>]`, one
    process per turn. It can't ask permission headless, so offer only "no shell" or "sandboxed
    auto". It has no list API: journal its sessions yourself in ~/.walkie/journal/agy/*.jsonl.
- One small event vocabulary every adapter emits: user, text, thinking, tool (title, detail, diff,
  output, status running|ok|error), ask (permission|question), resolved, result, info, error. Every
  event has an id; pushing the same id replaces it in place. A per-session seq plus an epoch lets
  the phone ask "everything after seq N" when it reconnects. Streaming text travels as draft frames
  until the final text event.
- HTTP for reads and actions, one WebSocket for live frames, one shared key (x-api-key) that the
  server generates on first run into ~/.walkie/key (mode 600). `walkie pair` prints a
  walkie://pair?host=…&port=…&key=… link and a QR code; host = the Mac's Tailscale name when
  available, else <LocalHostName>.local.
- Scrub ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, XAI_API_KEY from the
  server's environment before spawning anything, so the CLIs always run on my subscriptions.
- Install as a LaunchAgent with KeepAlive. Provide scripts/install-service.sh.
- ios/: SwiftUI, iOS 17+, XcodeGen project.yml, no third-party packages.

THE APP
- Home is one screen: a usage strip (a ring per subscription, percent left, when it resets), a
  "Needs you" section (sessions waiting on an answer), then every conversation from every CLI,
  newest first, with an agent badge, project name and time. Swipe to rename or archive (in the
  CLI's own record when it has one). Search across titles and transcript text. Compose = pick a
  project folder, pick a model, type.
- A conversation reads like a chat and keeps the CLI's power inline: tool calls collapse into one
  "N steps" line you can open; diffs are colored; permission and question cards sit above the
  composer; slash commands (Claude) and skills (Codex, inserted as $name); a model chip and an
  effort menu; photo/file attachments (uploaded to ~/.walkie/uploads on the Mac and referenced by
  path); Stop while running.
- Usage meters, none of which may spend quota: Claude through the Agent SDK's usage call plus
  rate_limit_event from live sessions; Codex through account/rateLimits/read; Antigravity through
  `agy -p /usage --output-format json` (a local command, zero tokens). Grok has no account meter.
- Continue in another subscription: from any conversation, start a new one on a different CLI in
  the same folder whose first message carries the old transcript (oldest first, newest kept when
  it's long) followed by what I type. No model call for a summary. The phone shows the transcript
  as one quiet collapsed note and only my words as a bubble. Link the two conversations both ways.
  When a plan is spent (meter full, or the last turn ended on a usage-limit error), show a bar
  offering this.
- Send to projects: from any conversation, ask its agent (one turn) to split what we agreed into
  {"tasks":[{"project","title","brief"}]}, choosing only from my real project folders, which you
  list in the prompt. Show the reply as a plan card; "Review and start" lets me drop projects, edit
  briefs and pick a model per project, then starts one session per project, sequentially, each
  linked back.
- Personalization without a settings screen: ~/.walkie/walkie.json holds quick asks (global and per
  project), project display names, and hidden projects. The server watches the file and tells the
  phone. Write a SKILL.md that teaches any agent to edit it.
- A built-in demo (pair with host "demo") that answers every request from bundled sample data, so
  the app is useful before a Mac is set up.

RELIABILITY (as important as simplicity)
- Phone outbox: a message shows at once, sends when the Mac is reachable, and runs exactly once
  (client id remembered by the server, persisted across restarts). A send that fails holds the
  messages behind it in the same conversation, so order is kept. A retried "start conversation"
  that arrives while the first is still booting gets the same session.
- The phone pings over the socket every 20s and on returning to the foreground; no pong in time
  means reconnect. Reconnecting reloads lists and catches up open conversations from their seq.
- A CLI that is missing, hangs or crashes never takes the server down: spawn errors and exits fail
  the waiting calls with a sentence I can act on ("Codex isn't installed on this Mac"), end live
  turns with an error event, and the next call starts it fresh. Quick RPCs time out; a hung list
  never hangs a screen. A turn that fails to start never leaves a session looking busy. Log
  unhandled errors instead of crashing.

DONE WHEN
- `npm test` in mac/ covers: event upserts and asks; each adapter against a fake CLI; missing,
  silent and crashing CLIs; a hung list; exactly-once sends and in-flight duplicate starts;
  catch-up by seq; continue-elsewhere text; send-to-projects plan and dispatch with a missing
  folder; walkie.json parsing with bad entries. All green.
- The iOS unit tests cover pairing links, frame decoding, the outbox surviving a killed app, the
  continued-conversation note, plan parsing and the demo data. All green.
- On a simulator, paired with the real server, Home lists my real conversations from every CLI I
  have, a conversation opens with its full history, and killing the server shows "Can't reach your
  Mac" and then recovers by itself when it comes back. Show me screenshots.
- The app is installed on my iPhone and paired with my Mac.
```
