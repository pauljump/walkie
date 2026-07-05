// One task, run through the #work room — the watchable heart of the team.
// Mara hands it off → the engineer acks in their own voice → a builder does the real work
// in a fresh WORKTREE of the sandbox (raw output on hidden #build) → the orchestrator turns
// that branch into a PR → the engineer reports → it's written to their track record.
// Returns the outcome (incl. PR link) for Mara to relay to the Director.
//
// Parallel-safe: each call gets its OWN build (its own worktree + its own uniquely-named
// worker), so many tasks can run at once without stomping each other. The build is torn
// down in `finally` — on success AND on failure — so a crash never leaks a worktree.
//
// Safety: the builder makes file changes only. It never runs git or touches main — the
// build owns branch→commit→push→PR, so everything lands as a PR the Director reviews.

import { readFileSync } from 'node:fs';
import { pickDemoBundle, stageBundle, deriveMeta, publishDemo } from './gallery.mjs';
import { track } from './telemetry.mjs';

// Best-effort time box for the post-build tail (the engineer's report + relaying it). The build
// is already done and the PR is open by this point, so a slow or stuck relay must never strand
// the task "in flight" — it falls back and lets the verdict surface. (Belt-and-suspenders for #101.)
const withTimeout = (p, ms, fallback) =>
  Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);

export function makeRoom({ conductor, team, speakers, repo, log = () => {} }) {
  // `onProgress({ phase, worker, directive, ack, taskId })` is an optional, fire-and-forget hook
  // the orchestrator uses to track + narrate the build. Driven by REAL milestones, never a timer:
  //   • 'acked' — the engineer picked the task up (Mara narrates their plan)
  //   • 'built' — the worker finished and was released (stop the "still building" heartbeat)
  return async function runRoom({ worker, directive, taskId = 0, onProgress }) {
    const eng = team.get((worker || '').toLowerCase());
    const name = eng ? eng.name : worker || 'builder';
    const speaker = eng ? speakers.get(eng.name.toLowerCase()) : null;

    // A fresh, isolated worktree off clean origin/main, just for this task.
    const build = repo.build(`${name}-${directive}`);
    build.prepare();
    try {
      if (eng) {
        await conductor.say(`${name}, take this: ${directive}`, { channel: 'work' });
        const ack = await eng.ack(directive);
        await conductor.say(ack, { channel: 'work', as: speaker });
        // Real milestone: the engineer has the task and a plan — let Mara tell the Director.
        try { onProgress?.({ phase: 'acked', worker: name, directive, ack, taskId }); } catch {}
      }

      // The hands: a builder makes the changes in this task's worktree. It does NOT run git.
      // We give the ABSOLUTE worktree path, not "the current directory": the harness does not
      // reliably honor the spawn cwd (the worker can land in the conductor's dir instead), so
      // relying on cwd silently drops the build. The worker runs locally and can write to the
      // absolute path regardless of where it was spawned. (See issue #31.)
      //
      // The worker name carries the task id, zero-padded to a fixed width so no name is a
      // substring of another (TheoHands0001 vs TheoHands0012) — that keeps report-matching and
      // PTY cleanup targeted when several builds run in parallel.
      const handsName = `${name}Hands${String(taskId).padStart(4, '0')}`;
      const buildTask = [
        `You are an engineer on a build task. A git checkout is waiting for you at this ABSOLUTE path:`,
        ``,
        `    ${build.dir}`,
        ``,
        `Make ALL of your file changes INSIDE that exact directory (always use the absolute path — do`,
        `not assume your current working directory is the checkout; it may not be). Create or edit files`,
        `only. Do NOT run git, do NOT commit, push, or open a PR — that is handled for you.`,
        ``,
        `Task: ${directive}`,
      ].join('\n');
      const result = await conductor.dispatch({
        name: handsName, engine: 'claude', model: 'sonnet',
        directive, task: buildTask, channel: 'build', cwd: build.dir,
        verify: () => build.hasChanges(),
        timeoutMs: 600000,   // real builds run minutes (Theo's game took 4m16s); don't abandon them at 150s
      });

      // The worker is done and released — the keyboard has stopped. Tell the orchestrator NOW so
      // the "still building" heartbeat goes quiet while we capture the demo, open the PR, and
      // write the report (all downstream of here). Without this the heartbeat narrates a build
      // that's already finished. (Issue #101.)
      try { onProgress?.({ phase: 'built', worker: name, directive, taskId }); } catch {}

      // If this build produced a web page, capture its bytes NOW — finalize() (next) tears the
      // worktree down, so we read the demo bundle while it still exists and publish it AFTER,
      // when we have the PR link to put on the gallery card. A non-web build stages nothing.
      let demo = null;
      try {
        if (build.hasChanges()) {
          const bundle = pickDemoBundle(build.changedFiles());
          if (bundle) {
            const html = readFileSync(bundle.entryAbs, 'utf8');
            const { title: demoTitle, slug } = deriveMeta({ html, directive });
            demo = { slug, title: demoTitle, blurb: directive, files: stageBundle(bundle) };
          }
        }
      } catch (err) {
        log(`demo capture skipped: ${err.message}`);
      }

      // Turn the branch into a PR the Director can review (this also tears the worktree down).
      const title = directive.replace(/\s+/g, ' ').trim().slice(0, 70);
      const final = build.finalize({
        title,
        body: `Built by **${name}** on a Walkie walking standup.\n\n**Task:** ${directive}\n\n_Review and merge if it's good._\n\n🤖 via Walkie`,
      });

      // Worktree is gone now — ship the staged bytes live to the gallery (best effort; a publish
      // failure never fails the build, the PR still stands).
      let demoUrl = null;
      if (demo && final.verified) {
        try {
          ({ demoUrl } = publishDemo({ ...demo, prUrl: final.prUrl }));
          log(`demo live: ${demoUrl}`);
        } catch (err) {
          log(`publish failed: ${err.message}`);
        }
      }

      const notes = (result.text || '') + (final.prUrl ? ` — PR: ${final.prUrl}` : final.branch ? ` — local branch: ${final.branch}` : '') + (demoUrl ? ` — live: ${demoUrl}` : '');
      let report = notes;
      if (eng) {
        // Time-boxed: the PR is already open, so a slow report turn or a stuck relay must not
        // keep the task counted as in-flight. Fall back to the raw notes if either drags.
        report = await withTimeout(eng.report({ directive, verified: final.verified, notes }), 60000, notes);
        await withTimeout(conductor.say(report, { channel: 'work', as: speaker }), 15000, undefined);
        eng.remember({ directive, verified: final.verified });
      }
      log(`${name} ${final.verified ? 'PR opened' : 'blocked'}: ${directive.slice(0, 70)}`);
      track('build_done', { ok: final.verified === true });  // count + boolean only — never the directive

      return { verified: final.verified, report, prUrl: final.prUrl, branch: final.branch, demoUrl };
    } finally {
      build.cleanup(); // no-op if finalize already cleaned; catches the error path
    }
  };
}
