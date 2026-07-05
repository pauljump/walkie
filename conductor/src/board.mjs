// The team's in-flight build board + the "still building" heartbeat.
//
// Why this is its own module: the heartbeat narrates "still building" to the Director while the
// team works, but a build has two distinct stretches and only the FIRST is "the keyboard going":
//
//   1. building  — a harness worker is actually running, writing files.
//   2. wrapping  — the worker is RELEASED; we're opening the PR + writing the engineer's report.
//
// Issue #101: a task used to count as "in flight" for its whole lifecycle, so the heartbeat kept
// saying "I can hear the keyboard" through the wrapping stretch — i.e. after the build was done
// and the PR was already open. A computer shouldn't say it's working when it's done.
//
// So the board tracks a phase per task. The heartbeat fires ONLY for tasks that are actually
// `building`. `markBuilt(id)` flips a task to `wrapping` (still visible to check_work, but no
// longer "the keyboard"); `remove(id)` clears it once the verdict is surfaced.

const DEFAULT_HEARTBEAT_MS = 75000;
const HEARTBEAT_LINES = [
  'Still going — the team is deep in it.',
  "Hang tight, still building. I'll ping you the moment it lands.",
  'Almost there — I can hear the keyboard, give it a sec.',
];

export function makeBoard({ say, heartbeatMs = DEFAULT_HEARTBEAT_MS, log = () => {} } = {}) {
  const tasks = new Map(); // id -> { worker, directive, startedAt, building }
  let timer = null;
  let idx = 0;

  const buildingCount = () => {
    let n = 0;
    for (const r of tasks.values()) if (r.building) n++;
    return n;
  };

  // A single shared timer that only speaks while at least one worker is actually building, and
  // stops the instant the last one is released — so the gap of a real build isn't dead air, but
  // a finished build never gets narrated as ongoing. Zero model cost (a fixed string).
  function ensureHeartbeat() {
    if (timer || buildingCount() === 0) return;
    timer = setInterval(() => {
      const building = buildingCount();
      if (building === 0) { clearInterval(timer); timer = null; return; }
      const line = building > 1
        ? `Still going — ${building} builds running in parallel. I'll surface each as it lands.`
        : HEARTBEAT_LINES[idx++ % HEARTBEAT_LINES.length];
      Promise.resolve(say(line)).catch(() => {});
    }, heartbeatMs);
  }

  // Whether builders are jailed this run (sandbox-exec). Purely for honest logging / check_work;
  // it does not gate anything. Derived from the same signal run-live logs at startup.
  const jailStatus = process.env.WALKIE_PROFILE_DENY === '1' ? 'jailed' : 'no-jail';

  return {
    // A new build just started — a worker is running.
    add(id, { worker, directive }) {
      tasks.set(id, { worker, directive, startedAt: Date.now(), building: true, jailStatus });
      ensureHeartbeat();
    },
    // The worker finished and was released. Stop counting it toward the "still building"
    // heartbeat while we open the PR + write the report; it stays on the board for check_work.
    markBuilt(id) {
      const r = tasks.get(id);
      if (r) r.building = false;
    },
    // Verdict surfaced — clear the task entirely.
    remove(id) { tasks.delete(id); },
    size: () => tasks.size,
    buildingCount,
    // What `check_work` reads aloud — honest about which tasks are typing vs wrapping up.
    list() {
      if (tasks.size === 0) return 'Nothing is building right now — the board is clear.';
      const now = Date.now();
      const lines = [...tasks.values()].map((r) => {
        const secs = Math.round((now - r.startedAt) / 1000);
        const state = r.building ? `building, ${secs}s in` : `wrapping up (opening the PR), ${secs}s in`;
        return `- ${r.worker}: "${r.directive.slice(0, 80)}" — ${state}`;
      });
      return `${tasks.size} task(s) in flight:\n${lines.join('\n')}`;
    },
    // For shutdown / tests: stop the heartbeat timer so the process can exit cleanly.
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
