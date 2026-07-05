// The DIRECT jailed spawner — replaces the Agent Relay PTY harness for the claude BUILDER.
//
// Instead of launching a long-lived PTY worker that joins a relay channel and lingers as a zombie
// (the old path: `agent-relay-broker pty --agent-name … claude …`, which never self-exits and had
// to be pkill'd in dispatch's finally), we spawn `claude` ONE-SHOT in print mode. stdout IS the
// bus: the worker does its file work, ends with a `DONE:` line, and the process exits on its own.
// No PTY, no relay round-trip, no lingering process, no pkill scan.
//
// It calls the `claude` SHIM by ABSOLUTE path (conductor/bin/claude), never a bare `claude` off
// PATH — so the sandbox-exec jail can't be bypassed by a PATH change. Crucially, it injects the
// per-worker jail env the shim reads (WALKIE_WORKER_NAME / WALKIE_SANDBOX_DIR / WALKIE_STATE_DIR /
// WALKIE_PROFILE_DENY), which NOTHING set before — so until now the jail fell back to worker="worker"
// and an empty sandbox dir, and builds only wrote because worktrees live under /tmp (blanket-allowed).
// With WALKIE_SANDBOX_DIR=cwd set here, the jail correctly scopes writes to the task's worktree.
//
// Verification is NOT trust in the DONE line — the caller (room.mjs) still gates on build.hasChanges()
// (the git diff). The DONE line is only a completion signal + human-readable summary.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve the `claude` shim by absolute path. In-repo it's conductor/bin/claude (../bin from src/);
// in the mirrored $RUN layout the shim sits at $RUN/bin/claude and this file at $RUN/src/, so the
// same ../bin relative resolution holds. Computed from import.meta.url, matching the shim's own
// self-locating style (no hardcoded absolute path, no ~/.secrets).
export function resolveBinClaude() {
  const candidate = resolve(HERE, '..', 'bin', 'claude');
  return candidate;
}

// The DONE-line instruction appended to every task. Kept close to the harness path's wording so
// prompts don't drift, but re-pointed: stdout is the bus now, so the worker ENDS its final message
// with a DONE line instead of posting to a #channel.
function withDoneInstruction(task, name) {
  return (
    `${task}\n\n` +
    `When you are completely finished, end your FINAL message with ONE line that starts with ` +
    `"DONE:" and briefly summarizes what you changed (e.g. "DONE: created hello.txt with the word walkie"). ` +
    `Do not print anything after that line.`
  );
}

// Match #waitForReport's tolerance: a line that CONTAINS "DONE" counts, but prefer a line that
// STARTS with "DONE:" (tighter — one-shot stdout is noisier than a single relay post). Scans
// bottom-up so the LAST DONE wins.
function extractDone(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (/^DONE:/i.test(lines[i])) return lines[i];
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('DONE')) return lines[i];
  return lines.length ? lines[lines.length - 1] : null; // fall back to the last non-empty line
}

// spawnClaudeWorker — run one jailed, one-shot claude build. Resolves when the process EXITS
// (self-exit; no lingering PTY) or when the timeout kills it (still resolves with whatever was
// captured, mirroring the old dispatch's timeout-still-returns behavior).
//
//   name       worker label (feeds the jail profile filename)
//   task       the build task text (the DONE instruction is appended here)
//   cwd        the task's worktree — spawned cwd AND the jail's writeable sandbox dir
//   model      optional model alias (e.g. "sonnet")
//   stateDir   Walkie state dir (jail allows writes here too)
//   jail       true → enforce the sandbox-exec jail (WALKIE_PROFILE_DENY=1)
//   realClaude optional explicit path to the real claude (tests point this at a fake)
//   binClaude  optional override for the shim path (defaults to resolveBinClaude())
//   timeoutMs  hard cap; SIGTERM then SIGKILL
//   onLine     optional per-stdout-line hook (tee build output onto #build)
//   log        logger
export function spawnClaudeWorker({
  name = 'builder',
  task,
  cwd,
  model,
  stateDir,
  jail = true,
  realClaude,
  binClaude,
  timeoutMs = 600000,
  onLine,
  log = () => {},
} = {}) {
  const shim = binClaude || resolveBinClaude();
  if (!existsSync(shim)) {
    return Promise.reject(new Error(`claude shim not found at ${shim} (expected conductor/bin/claude)`));
  }

  // Headless one-shot. -p/--print = non-interactive (confirmed against the installed CLI --help).
  // The builder runs INSIDE the sandbox-exec jail, so --dangerously-skip-permissions is the
  // CLI's own recommended mode for "sandboxes with no [dangerous] access" — the jail, not the
  // permission prompt, is the guardrail. Text output; stdout is the bus.
  const args = ['-p', withDoneInstruction(task, name)];
  if (model) args.push('--model', model);
  args.push('--permission-mode', 'bypassPermissions');

  const env = {
    ...process.env,
    WALKIE_WORKER_NAME: name,
    WALKIE_SANDBOX_DIR: cwd || '',
    WALKIE_STATE_DIR: stateDir || join(process.env.HOME || '', '.walkie'),
    WALKIE_PROFILE_DENY: jail ? '1' : '0',
    ...(realClaude ? { WALKIE_REAL_CLAUDE: realClaude } : {}),
  };

  log(`spawn-claude: ${name} (jail=${jail ? 'on' : 'off'}) in ${cwd}`);

  return new Promise((resolve) => {
    // detached so we can kill the whole process group on timeout — a build may fork grandchildren
    // (git/node/gh); killing just the parent could orphan them.
    const child = spawn(shim, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let pending = ''; // partial trailing line buffer for onLine

    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log(`spawn-claude: ${name} timed out after ${timeoutMs}ms — terminating`);
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onLine) {
        pending += s;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const line of parts) { const t = line.trim(); if (t) { try { onLine(t); } catch {} } }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onLine && pending.trim()) { try { onLine(pending.trim()); } catch {} }
      const doneLine = extractDone(stdout);
      const text = doneLine ?? (stderr.trim() ? `no output (stderr: ${stderr.trim().slice(0, 200)})` : null);
      log(`spawn-claude: ${name} exited (code ${exitCode}${timedOut ? ', timed out' : ''}) → ${text ? text.slice(0, 120) : 'no text'}`);
      resolve({ text, done: !!doneLine, exitCode: exitCode ?? (timedOut ? 124 : null), timedOut, stdout, stderr });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`spawn-claude: ${name} spawn error: ${err.message}`);
      resolve({ text: `spawn error: ${err.message}`, done: false, exitCode: null, timedOut, stdout, stderr: String(err.message) });
    });
    child.on('exit', (code) => finish(code));
  });
}
