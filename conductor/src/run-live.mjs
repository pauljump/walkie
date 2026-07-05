// Walkie live conductor — a real conversation with your EM, and the team room behind her.
// The EM "Mara" is a persistent Claude mind (mara.mjs). She attaches to the shared workspace,
// watches #standup, talks WITH the Director, and — only on a concrete build task — runs the
// #work room: she hands it to a named, persistent engineer (team.mjs) who acks in their own
// voice, a harness worker does the real build, the engineer reports, and Mara gives the
// Director the verdict on #standup. The Director can watch #work; only Mara reaches his ear.
//
// MULTITASKING (the hero feature): builds run in the BACKGROUND and in PARALLEL. Mara is
// never blocked while a worker builds — she keeps talking, and can put several engineers on
// several tasks at once. When a build lands, it surfaces itself as a fresh turn she relays.
//
//   1. terminal A:  node src/broker.mjs      (the phone's on-ramp)
//   2. terminal B:  node src/run-live.mjs     (this — the EM + the team)
//   3. the phone posts to #standup as "Director"
//
// Operator-triggered only: Mara's brain, the engineers, and any worker run ONLY when the
// Director speaks (or when a task he already gave finishes). No timers, no autonomous loops.

import { makeBus } from './bus.mjs';
import { advertiseWalkie } from './bonjour.mjs';
import { Mara } from './mara.mjs';
import { loadTeam } from './team.mjs';
import { makeRoom } from './room.mjs';
import { SandboxRepo } from './workspace.mjs';
import { loadConfig, requireWorkspaceKey } from './config.mjs';
import { ConfirmGate } from './confirm-gate.mjs';
import { listPublishedDemos, publicDemoUrl } from './gallery.mjs';
import { makeBoard } from './board.mjs';
import { withRetry } from './retry.mjs';
import { track } from './telemetry.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Everything Paul-specific is gone: the sandbox dir/repo, the Director's name, and the factory
// root all come from the per-user config (~/.walkie/config.json), with WALKIE_* env overrides for
// CI. The builders work in a checkout of the operator's OWN practice repo; each task becomes a
// real PR they review.
const cfg = loadConfig();
const SANDBOX_DIR = cfg.sandboxDir;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A GitHub sandbox repo is OPTIONAL now. On a fresh self-host install the wizard makes a local
// scratch repo (~/walkie-scratch) and leaves sandboxRepo unset — the team builds there so the
// first walk works with no GitHub account. Set sandboxRepo in ~/.walkie/config.json later to turn
// on the "open a PR on my real repo" path. requireSandboxRepo (which throws) is only used on that
// PR path; here we read the plain field and boot either way.
const SANDBOX_REPO = cfg.sandboxRepo || null;
if (!existsSync(join(SANDBOX_DIR, '.git'))) {
  SANDBOX_REPO
    ? log(`⚠️  no sandbox checkout at ${SANDBOX_DIR} — clone ${SANDBOX_REPO} there first (gh repo clone ${SANDBOX_REPO} ${SANDBOX_DIR}).`)
    : log(`⚠️  no git repo at ${SANDBOX_DIR} — run the wizard once (install-service.sh --init) to make the scratch project.`);
}
if (!SANDBOX_REPO) {
  log('scratch mode: no GitHub repo set, so builds land in your local scratch project (branch + diff you read on the Mac), not a PR. Set sandboxRepo in ~/.walkie/config.json to open PRs on your own repo.');
}

// The jail state has ONE source of truth: cfg.jailProfile (from ~/.walkie/config.json). No plist
// env, no PATH trick — flip the config and restart the service and it takes effect, period. This
// killed the old split-brain bug where the plist forced WALKIE_PROFILE_DENY=1 and a stale process
// served the wrong state for hours. On the local transport the DIRECT spawner injects the per-worker
// jail env (WALKIE_SANDBOX_DIR=the worktree, WALKIE_PROFILE_DENY per-build) and calls the `claude`
// shim by absolute path, so the sandbox-exec profile scopes writes to the task worktree when on.
// Default is OFF (see config.mjs): jailed builders can't reach the subscription login. ON is the
// hardened opt-in and needs a BYO metered API key.
const JAILED = cfg.jailProfile === true;
log(JAILED
  ? 'jail ON — builders run inside a sandbox-exec profile (needs a BYO API key; the subscription login is unreachable from the jail)'
  : 'jail OFF (default) — builders run on your Mac with your Claude subscription login, unconfined');

// Select the transport (self-host 'local' bus by default; 'agent-relay' = the original hosted path).
// The workspace key is ONLY read for the agent-relay path — the local bus needs no rk_live_ key.
const workspaceKey = cfg.transport === 'agent-relay' ? requireWorkspaceKey(cfg) : undefined;
const c = await makeBus(cfg, {
  workspaceKey,
  cwd: SANDBOX_DIR,
  log,
  build: { jail: JAILED, stateDir: cfg.stateDir },
});
await c.start();

// Advertise on the LAN via Bonjour so the phone can discover this Mac with zero typing (only on the
// self-host local bus; the agent-relay path has its own hosted on-ramp). The advertiser is a
// long-lived dns-sd child that must be reaped on exit, or a stale record could point at a dead port.
// It's a convenience — if dns-sd is missing it logs one line and the typed address still works.
let mdns = { stop() {} };
if ((cfg.transport || 'local') !== 'agent-relay') {
  mdns = advertiseWalkie({ port: cfg.brokerPort, name: cfg.directorName, log });
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { mdns.stop(); } catch {} });
  }
}

const mara = new Mara({ log, directorName: cfg.directorName });

// The persistent team — Theo, Cora, Nia — each registered as their own voice in #work.
const team = loadTeam({ log });
const speakers = new Map();
for (const eng of team.values()) speakers.set(eng.name.toLowerCase(), await c.registerSpeaker(eng.name));
log(`team online: ${[...team.values()].map((e) => e.name).join(', ')}  → sandbox ${SANDBOX_REPO || `${SANDBOX_DIR} (local scratch, no PRs)`}`);

// Each task gets its own isolated worktree (parallel-safe). Prune any worktrees a previous
// crash left behind.
const repo = new SandboxRepo({ root: SANDBOX_DIR, repo: SANDBOX_REPO, log });
repo.pruneStale();
const runRoom = makeRoom({ conductor: c, team, speakers, repo, log });

// ── Mara's brain is serialized; her builds are not. ──────────────────────────────────────
//
// turnChain: a one-at-a-time queue for everything that touches Mara's mind (a Director
// utterance, or a finished build that needs a verdict). Model calls mutate one shared
// history and the tool-use/tool-result pairing must stay intact, so they never overlap.
// Each turn is short (seconds of thinking) — the long part (the build) is NOT on this queue.
let turnChain = Promise.resolve();
function enqueueTurn(job) {
  turnChain = turnChain.then(job).catch((err) => log(`turn error: ${err.message}`));
  return turnChain;
}

// board: every background build running right now, so Mara (via check_work) and the logs can
// see the whole board at a glance. It also owns the "still building" heartbeat — a DETERMINISTIC
// "still going" line (zero model cost, not an API call) that fills the long quiet stretch of a
// build so the gap isn't dead air. Crucially, the heartbeat only fires for tasks whose worker is
// actually running; once a worker is released and we're just opening the PR, the task stops
// counting as "building" (see markBuilt on the 'built' milestone below) — so Mara never says
// "I can hear the keyboard" after the build is done and the PR is already up. (Issue #101.)
let taskSeq = 0;
const board = makeBoard({ say: (t) => c.say(t), log });
const listWork = () => board.list();

// ── Keeping the Director in the loop while the team builds (Paul's "narrate it" ask). ──────
//
// Milestone narration (compliant with "no autonomous paid LLM calls"): when an engineer picks a
// task up, Mara voices their plan to the Director — driven by a REAL event (the ack), which
// stems from his dispatch, not a timer. The 'built' milestone is bookkeeping only: the worker is
// done, so we flip the task off the "building" heartbeat while the PR opens (no narration here).
function onProgress({ phase, worker, directive, ack, taskId }) {
  if (phase === 'built') { board.markBuilt(taskId); return; }
  if (phase !== 'acked') return;
  const note = `[Progress update — not from the Director] ${worker} just picked up the task "${directive}" and their plan is: "${ack}". In ONE short, natural sentence in your own voice, tell the Director what's happening right now. Don't ask him anything, don't dispatch — just narrate briefly.`;
  enqueueTurn(() => mara.respond(note, makeIo(null), { tools: false }));
}

// Fire-and-forget: start a build in the background and return an immediate ack for Mara to
// hand back to the Director. The real work runs in PARALLEL with the conversation and with
// every other build; when it lands it surfaces itself as a fresh turn.
function startTask({ worker, directive }) {
  const id = ++taskSeq;
  board.add(id, { worker, directive }); // starts the heartbeat while a worker is actually building
  log(`▶ task #${id} ${worker}: ${directive.slice(0, 70)}  (in flight: ${board.size()})`);

  // Wrap the whole build in withRetry: the worker is a separate `claude` CLI process, so the
  // SDK's per-call retries can't cover it — a transient 500 mid-build can only be survived by
  // re-running the build. Up to 3 attempts on a transient error; a real failure (or a "blocked"
  // outcome, which doesn't throw) surfaces normally. Each attempt cuts a fresh worktree.
  withRetry(() => runRoom({ worker, directive, taskId: id, onProgress }), {
    attempts: 3,
    onRetry: (n, err) => log(`↻ task #${id} ${worker} hit a transient error (attempt ${n}): ${String(err.message).slice(0, 70)} — retrying`),
  })
    .then((outcome) => {
      board.remove(id);
      log(`✓ task #${id} ${worker} ${outcome.verified ? 'verified' : 'blocked'}  (in flight: ${board.size()})`);
      const note = outcome.verified
        ? `[Background update — not from the Director] ${worker}'s task just finished and VERIFIED (the code really changed): "${directive}".${outcome.prUrl ? ` PR for the Director to review — share this link: ${outcome.prUrl}` : outcome.branch ? ` It landed in the scratch project on the local branch "${outcome.branch}" (no PR — that turns on once the Director points Walkie at a real GitHub repo in Settings). Do NOT invent a PR link; if he wants to read it, it's on the Mac.` : ''}${outcome.demoUrl ? ` It also shipped LIVE on the web — the Director can open it right now: ${outcome.demoUrl}` : ''} Tell the Director now, briefly, in your own voice${outcome.demoUrl ? ', and give him the live link' : ''}.`
        : `[Background update — not from the Director] ${worker}'s task came back BLOCKED — nothing verifiable was built: "${directive}". Their note: ${outcome.report || 'none'}. Tell the Director, and say what you'd do next.`;
      enqueueTurn(() => mara.respond(note, makeIo(null)));
    })
    .catch((err) => {
      board.remove(id);
      log(`✗ task #${id} ${worker} errored: ${err.message}  (in flight: ${board.size()})`);
      enqueueTurn(() =>
        mara.respond(
          `[Background update — not from the Director] ${worker}'s task hit an error on "${directive}": ${err.message}. Tell the Director briefly and honestly.`,
          makeIo(null),
        ),
      );
    });

  const others = board.size() - 1;
  return `Started ${worker} on it in the background${others > 0 ? ` — that's ${board.size()} running in parallel now` : ''}. Keep talking; I'll surface the result the moment it lands.`;
}

// ── The confirmation gate: nothing builds until the Director says yes. ─────────────────────
//
// Mara PROPOSES a build (records the plan, starts nothing) and only STARTS it after he confirms.
// The gate enforces this structurally: a proposal is stamped with the Director turn it was made
// on, and start_work is only honored on a LATER Director turn (a real second utterance). Mara
// can't fabricate the Director's go-ahead, so she can't propose-and-launch in one breath.
const gate = new ConfirmGate();
let directiveSeq = 0;

// Mara's eyes on work that already exists (so she stops rebuilding duplicates / saying "no record").
function listPrs() {
  if (!SANDBOX_REPO) {
    return 'No GitHub repo set yet, so there are no PRs — builds land in the local scratch project as branches on the Mac. Point Walkie at a repo in Settings to open PRs.';
  }
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--repo', SANDBOX_REPO, '--state', 'open', '--json', 'number,title,url', '--limit', '20'],
      { encoding: 'utf8' },
    );
    const prs = JSON.parse(out);
    if (!prs.length) return 'No open PRs in the sandbox right now.';
    return `Open PRs (newest first):\n${prs.map((p) => `- #${p.number}: ${p.title.slice(0, 90)} — ${p.url}`).join('\n')}`;
  } catch (err) {
    return `Couldn't read the PRs: ${err.message}`;
  }
}

// Read ONE PR in full (title + body + diff), scoped to the sandbox repo only — never the
// monorepo. The diff is capped so a huge PR can't blow up Mara's context; she reads it to
// understand, then summarizes for the Director (she's told never to read a diff aloud).
function readPr(number) {
  if (!SANDBOX_REPO) return 'No GitHub repo set yet, so there are no PRs to read. Builds land locally in the scratch project.';
  const n = Number.parseInt(number, 10);
  if (!Number.isInteger(n) || n <= 0) return 'I need a PR number to read one.';
  try {
    const meta = JSON.parse(
      execFileSync('gh', ['pr', 'view', String(n), '--repo', SANDBOX_REPO, '--json', 'number,title,body,state,url'], {
        encoding: 'utf8',
      }),
    );
    let diff = execFileSync('gh', ['pr', 'diff', String(n), '--repo', SANDBOX_REPO], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const CAP = 12000;
    if (diff.length > CAP) diff = `${diff.slice(0, CAP)}\n…(diff truncated)`;
    const body = meta.body ? `${meta.body.slice(0, 800)}\n\n` : '';
    return `PR #${meta.number}: ${meta.title} (${meta.state})\n${meta.url}\n\n${body}--- diff ---\n${diff}`;
  } catch (err) {
    return `Couldn't read PR #${n}: ${err.message}`;
  }
}

function listDemos() {
  const demos = listPublishedDemos();
  if (!demos.length) return 'Nothing is shipped to the gallery yet.';
  return `Live in the gallery now:\n${demos
    .map((d) => {
      const url = publicDemoUrl(d.slug);
      return `- ${d.title ?? d.slug}${url ? ` → ${url}` : ''}${d.pr ? ` (PR ${d.pr})` : ''}`;
    })
    .join('\n')}`;
}

// Per-turn io: the tool handlers, bound to THIS turn's Director-turn id (null for background/
// progress turns, which must never be able to start a build). proposeWork/startWork go through
// the gate; everything else is the same as before.
function makeIo(directiveId) {
  return {
    say: (t) => c.say(t),
    listWork,
    listPrs,
    readPr,
    listDemos,
    proposeWork: ({ worker, directive }) => {
      gate.propose({ worker, directive, turn: directiveId });
      log(`proposed ${worker}: ${directive.slice(0, 70)} (awaiting confirmation)`);
      return `Noted — ${worker} is lined up for that, but NOTHING has started. Tell the Director what ${worker} will do and ask him to confirm; only call start_work once he clearly says yes.`;
    },
    startWork: () => {
      const r = gate.start({ turn: directiveId });
      if (!r.ok) {
        if (r.reason === 'nothing-proposed') return "There's nothing proposed to start yet — propose it first.";
        if (r.reason === 'not-director-turn') return 'A build can only start right after the Director speaks.';
        if (r.reason === 'same-turn') return "Not yet — you just proposed that. Get the Director's explicit go-ahead first, THEN start it.";
        return "That can't be started right now.";
      }
      log(`Director confirmed → starting ${r.task.worker}: ${r.task.directive.slice(0, 70)}`);
      return startTask(r.task);
    },
  };
}

c.watch({
  directiveFrom: 'Director',
  onDirective: (directive) => {
    // Each Director utterance is its own turn id — that's what the gate keys on so a proposal
    // can only be started on a SEPARATE (later) utterance. Builds still run in the background.
    const did = ++directiveSeq;
    enqueueTurn(() => mara.respond(directive, makeIo(did)));
  },
});

log('live conductor up — Mara is listening on #standup, builds run in parallel. (Ctrl-C to stop)');
track('service_start');  // anonymous count of live instances — see telemetry.mjs
process.stdin.resume(); // keep alive
