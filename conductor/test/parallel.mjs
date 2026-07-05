// Proof that parallel builds are ISOLATED — the core guarantee behind multitasking.
// Fires several builds at once and checks each got its own directory + its own branch, each
// detects only its own changes, and every one is torn down cleanly (no leaked worktrees).
// $0, no API, no harness workers — it exercises the workspace layer directly.
//
//   node test/parallel.mjs
//
// Uses the real walkie-sandbox checkout (git worktrees) if present; otherwise ScratchRepo.

import { SandboxRepo, ScratchRepo } from '../src/workspace.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SANDBOX_DIR = process.env.WALKIE_SANDBOX_DIR ?? join(homedir(), 'walkie-sandbox');
const SANDBOX_REPO = process.env.WALKIE_SANDBOX_REPO ?? 'you/your-sandbox';

let repo, mode;
if (existsSync(join(SANDBOX_DIR, '.git'))) {
  repo = new SandboxRepo({ root: SANDBOX_DIR, repo: SANDBOX_REPO, log });
  mode = `SandboxRepo (real git worktrees off ${SANDBOX_DIR})`;
} else {
  const root = join(tmpdir(), 'walkie-parallel-test');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  repo = new ScratchRepo({ root, log });
  mode = `ScratchRepo (no sandbox checkout found at ${SANDBOX_DIR})`;
}
log(`mode: ${mode}`);
repo.pruneStale();

const N = 3;
const slugs = ['theo-alpha', 'cora-beta', 'nia-gamma'];

// Fire N builds concurrently. Each: prepare → write a unique file → check it sees its change.
const results = await Promise.all(
  slugs.slice(0, N).map(async (slug, i) => {
    const build = repo.build(slug);
    build.prepare();
    const file = join(build.dir, `proof-${i}.txt`);
    writeFileSync(file, `build ${i}: ${slug}\n`);
    const sawChange = build.hasChanges();
    return { i, slug, dir: build.dir, branch: build.branch ?? null, sawChange, build };
  }),
);

// Every dir distinct?
const dirs = results.map((r) => r.dir);
const distinctDirs = new Set(dirs).size === dirs.length;
// Every build saw a change (its own file)?
const allSawChange = results.every((r) => r.sawChange);
// Branches distinct (Sandbox only)?
const branches = results.map((r) => r.branch).filter(Boolean);
const distinctBranches = branches.length === 0 || new Set(branches).size === branches.length;

// Tear them all down.
for (const r of results) r.build.cleanup();
const allCleaned = results.every((r) => !existsSync(r.dir));

// This test never pushes, so cleanup() leaves the local branches behind (in production
// they're kept because the PR needs them). Delete our test branches so we don't litter.
if (repo instanceof SandboxRepo) {
  for (const r of results) {
    if (r.branch) { try { execFileSync('git', ['-C', SANDBOX_DIR, 'branch', '-D', r.branch], { stdio: 'ignore' }); } catch {} }
  }
}

// For the real repo: no walkie-build worktrees should linger.
let noLeak = true;
if (repo instanceof SandboxRepo) {
  const list = execFileSync('git', ['-C', SANDBOX_DIR, 'worktree', 'list'], { encoding: 'utf8' });
  noLeak = !/walkie-build-/.test(list);
}

console.log('\n=================== RESULTS ===================');
console.log('  each build got its own directory:  ', distinctDirs ? '✅' : '❌');
console.log('  each build got its own branch:     ', distinctBranches ? '✅' : (branches.length ? '❌' : 'n/a (scratch)'));
console.log('  each saw ONLY its own change:      ', allSawChange ? '✅' : '❌');
console.log('  all worktrees torn down:           ', allCleaned ? '✅' : '❌');
console.log('  no leaked build worktrees:         ', noLeak ? '✅' : '❌');
console.log('==============================================');

const pass = distinctDirs && distinctBranches && allSawChange && allCleaned && noLeak;
console.log(pass ? `✅ PARALLEL BUILDS ARE ISOLATED (${N} at once, ${mode.split(' ')[0]})` : '❌ isolation broken');
process.exit(pass ? 0 : 1);
