# Sync: one standard for every agent

Walkie is a remote, not a second home for your sessions. Each agent (Claude Code, Codex, Grok,
Antigravity, and whatever comes next) already keeps a record of its sessions on the Mac. **That record
is the truth; Walkie mirrors it.** A change made anywhere (terminal, desktop app, Remote Control,
Walkie) should show up everywhere.

## Who owns what

- **The agent owns the facts about a session:** that it exists, whether it's running, its name,
  whether it's archived.
- **Walkie keeps only what an agent can't:** a name or archived flag for an agent with no way to
  store one (`~/.walkie/overlay.json`).

Neither side writes the other's data.

## The session record

Every adapter's `list()` returns the same shape (field names follow ACP's `session/list` where it has
one):

| field | meaning |
|---|---|
| `agent`, `id` | which agent, and its own id. `key` = `agent:id` |
| `cwd`, `title`, `updatedAt`, `branch` | from the agent's record |
| `running` | a process for it is alive on this Mac right now |
| `remote` | the agent's own remote (Claude Remote Control) is on for it |
| `open` | set by the server: running or held by Walkie. For agents with no running signal (Codex, Grok, agy), also touched in the last 2 hours and not seen to stop |

Archived sessions are left out of lists.

## The verbs

`list`, `runningIds`, `rename`, `archive`. Each adapter declares how it does each one in
`sync: { … }`:

- **native**: done through the agent itself, so its own apps see it.
- **walkie**: the agent can't store it. Walkie keeps it in `~/.walkie/overlay.json`
  (`{ archived: [key], titles: { key: title } }`). The server's answer says `where: 'walkie'` so
  nothing claims to have synced when it didn't.
- **missing**: the phone hides the action.

Writes go to the agent first, then the list is re-read, so the agent's answer is what the phone shows.
If both hold a value, the agent wins; the overlay copy is cleared on every native write.

## Change flow

- **Agent → phone:** event-driven where the agent gives a cue (`watchRunning`), plus a 15 s sweep for
  sessions that die without one. On any change it asks the agent's own list again (`runningIds`). When
  something starts or stops, and after any rename or archive, it sends a `sessions` frame and the phone
  reloads what's on screen. A failed check keeps the last good answer instead of calling everything
  stopped.
- **Changed in the agent's own app:** adapters with `watchChanges` (Codex: its name index and archive
  folder) send a `sessions` frame so the phone re-reads.
- **Phone → agent:** `POST /api/session/rename` and `POST /api/session/archive`.

## Where each agent stands

| | running | name | archive | its own remote |
|---|---|---|---|---|
| **Claude** | native: `claude agents --json` (Claude Code's scripting interface, ~0.15 s), re-asked when a file in `~/.claude/sessions/` changes; Remote Control on/off read from those files as an undocumented hint | native: a session Walkie is running is told directly (the same `rename_session` message the Claude app sends, so Remote Control's name updates too); any other session gets Claude's title line via SDK `renameSession` | native: SDK `tagSession('archived')`, invisible in Claude's own apps | Remote Control can't be turned on for SDK-run sessions (tested 09-24: neither `remoteControlAtStartup` nor `--remote-control` connects; the flag is for interactive sessions). Walkie doesn't need it: phone → Tailscale → bridge |
| **Codex** | missing: `thread/loaded/list` only covers Walkie's own Codex process | native: `thread/name/set` (lands in `session_index.jsonl`, which the Codex apps read) | native: `thread/archive` / `thread/unarchive`; `thread/list` hides archived | Codex's shared daemon has its own remote control; Walkie doesn't use the daemon (its `proxy` isn't plain JSON-RPC and is experimental) |
| **Grok** | not yet: `~/.grok/active_sessions.json` | walkie | walkie | none |
| **Antigravity** | not yet: `conversation_summaries.db` | walkie | walkie | `agy --remote-control`, untested |

Rules for anything undocumented: read-only, skipped on any parse failure, never written.

## Voice chats (Codex)

Codex keeps what was said in a voice chat in its history database (`~/.codex/thread_history_1.sqlite`,
table `thread_realtime_items`), not in the thread itself, and no API reads it. Walkie reads it
read-only (`immutable=1`) and shows the spoken turns as messages marked "Spoken". Any failure just
means no transcript. Every voice chat with words in it was archived in Codex, so they show under
**Archived** (Home → Archived), which also lists everything archived in Claude, Codex or Walkie.

## Known limits

- **Walkie-started sessions don't appear in the Claude Code iOS app (decided 09-24: accepted).** The app
  lists only sessions registered with claude.ai (Remote Control), which Anthropic supports only for
  interactive terminal sessions. Tested and failed for SDK-run sessions: `remoteControlAtStartup`,
  `--remote-control`, and `autoUploadSessions` (mirror). Reopening a session interactively with
  `--remote-control` in a hidden terminal is the one untried path: it needs a real pty host (tmux)
  and a trusted folder. Sessions started in the iOS app do show in Walkie.

- Remote Control's list lives on claude.ai. Walkie mirrors what's running on this Mac, not that list,
  and never sees sessions on other machines.
- Renaming a Claude session that's running in a terminal or another app writes its title line, but that
  running session isn't told, so Remote Control keeps the old name until it restarts.
- Walkie won't send into a Claude session that's running in a terminal or the Claude app: resuming
  it would start a second copy writing the same file. It answers 409 `running_elsewhere` until the
  session is closed there. A proper "Take over" is planned.
- Sessions Walkie starts get a Claude-generated title after the first reply (`generateSessionTitle`,
  saved as Claude's own `ai-title`), matching what the terminal does. Older SDK sessions keep showing
  their last prompt; Remote Control may show a different
  name for the same session.
- Closing or archiving a Claude session in the Claude app ends its process (tested 09-24 with a
  session named Vayo), so it drops to Earlier here. The archive itself isn't recorded on the Mac, so
  Walkie can't hide it outright the way a Walkie archive does.

## Adding an agent

Implement `list` and declare `sync`. Then check by hand: rename both ways, archive both ways, close
elsewhere → drops to Earlier, start in Walkie → appears in the agent's own app.
