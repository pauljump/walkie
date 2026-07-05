import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Where a builder does its work, and how that work is captured. Built for PARALLEL builds:
// many tasks can be in flight at once (the Director multitasks), so every task gets its OWN
// isolated build — never a shared directory two workers would stomp.
//
//   SandboxRepo — a real git checkout (walkie-sandbox). `.build(slug)` cuts a fresh git
//   WORKTREE off origin/main: its own directory + its own branch, sharing the one object
//   store (cheap). The builder makes file changes there only; when it's done, the changes
//   become a real GitHub PR and the worktree is torn down. The builder NEVER touches main
//   and never runs git — the orchestrator owns branch→commit→push→PR. Safe "real repo".
//
//   ScratchRepo — throwaway directories with file-snapshot change detection. No git, no PR.
//   For headless tests that shouldn't reach GitHub. `.build(slug)` gives each task its own dir.
//
// Why no locks: Node is single-threaded and the git commands below are synchronous
// (execFileSync), so the repo bookkeeping (worktree add/remove, commit, push) is naturally
// mutually exclusive across parallel builds. The only thing that needs isolating is the
// working files — and that is exactly what a worktree gives each task. The slow part (the
// builder actually working) runs fully in parallel; only the quick git plumbing serializes.
//
// A Repo exposes: pruneStale(), build(slug) -> Build.
// A Build exposes: dir, prepare(), hasChanges(), finalize({title, body}) -> {verified, prUrl?}, cleanup().

function slugify(s) {
  return (s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

// A short non-colliding token so two builds of the "same" task never share a branch/dir.
let buildSeq = 0;
function buildTag(slug) {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  return `${slugify(slug)}-${stamp}-${(++buildSeq).toString(36)}`;
}

export class SandboxRepo {
  constructor({ root, repo, log = () => {} }) {
    this.root = root;     // a local checkout of `repo` (e.g. ~/walkie-sandbox)
    this.repo = repo;     // the operator's OWN sandbox repo, e.g. "myuser/my-sandbox-repo" (from config)
    this.log = log;
  }

  #git(args) {
    return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8' }).trim();
  }

  // Drop any build worktrees left over from a previous run that crashed mid-build.
  pruneStale() {
    try { this.#git(['worktree', 'prune']); } catch { /* best effort */ }
  }

  build(slug) {
    return new SandboxBuild({ root: this.root, repo: this.repo, slug, log: this.log });
  }
}

class SandboxBuild {
  constructor({ root, repo, slug, log }) {
    this.root = root;
    this.repo = repo;
    this.slug = slug;
    this.log = log;
    this.dir = null;
    this.branch = null;
  }

  #rootGit(args) {
    return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8' }).trim();
  }

  #git(args) {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8' }).trim();
  }

  // Cut a fresh worktree off a freshly-fetched origin/main — isolated from every other
  // build in flight (its own directory + its own branch).
  prepare() {
    this.#rootGit(['fetch', 'origin', '--quiet']);
    const tag = buildTag(this.slug);
    this.branch = `walkie/${tag}`;
    this.dir = join(tmpdir(), `walkie-build-${tag}`);
    this.#rootGit(['worktree', 'add', '-q', '-b', this.branch, this.dir, 'origin/main']);
    this.log(`build worktree ${this.branch} → ${this.dir}`);
  }

  hasChanges() {
    return this.#git(['status', '--porcelain']).length > 0;
  }

  // The files this build added or modified, as { rel (repo-relative, '/'-separated), abs }.
  // `-uall` lists individual untracked files (not just their parent dir) so a brand-new demo
  // folder is enumerated file-by-file. Deletions are dropped; a rename reports its new path.
  // This is how the gallery knows WHICH files to ship (vs the whole sandbox checkout).
  changedFiles() {
    const out = this.#git(['status', '--porcelain', '-uall']);
    if (!out) return [];
    const files = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      if (code.includes('D')) continue; // skip deletions
      let rel = line.slice(3);
      const arrow = rel.indexOf(' -> ');
      if (arrow >= 0) rel = rel.slice(arrow + 4); // rename: take the destination path
      rel = rel.replace(/^"|"$/g, ''); // git quotes paths with odd chars
      files.push({ rel, abs: join(this.dir, rel) });
    }
    return files;
  }

  // Commit the builder's changes, open a real PR (if this is a GitHub repo), then tear the
  // worktree down. Returns { verified, prUrl?, branch? }. Always cleans up — even when nothing
  // was built.
  //
  // Two shapes, one flow:
  //   • GitHub repo (sandboxRepo set): commit → push origin → `gh pr create` → PR URL. The Director
  //     reviews on the phone. This is the original path, unchanged.
  //   • Local scratch repo (no GitHub remote): commit → push to the local origin. There is no PR to
  //     open, so we return the branch name instead of a URL. The build still landed as a readable
  //     branch + diff on the Mac (`git -C <scratchDir> log <branch>`); the Director points Walkie at
  //     a real repo in Settings to turn on PRs. This is what makes the first walk work with no
  //     GitHub account. (Honest: no phantom PR link is ever surfaced.)
  finalize({ title, body }) {
    let result = { verified: false };
    try {
      if (this.hasChanges()) {
        this.#git(['add', '-A']);
        this.#git(['commit', '-q', '-m', title]);
        this.#git(['push', '-u', 'origin', this.branch, '--quiet', '--force']);
        if (this.repo) {
          const url = execFileSync(
            'gh',
            ['pr', 'create', '--repo', this.repo, '--head', this.branch, '--base', 'main', '--title', title, '--body', body],
            { cwd: this.dir, encoding: 'utf8' },
          ).trim();
          this.log(`PR opened: ${url}`);
          result = { verified: true, prUrl: url };
        } else {
          this.log(`scratch build committed to branch ${this.branch} (local only — no PR; set sandboxRepo for PRs)`);
          result = { verified: true, branch: this.branch };
        }
      }
    } finally {
      this.cleanup();
    }
    return result;
  }

  // Remove the worktree (and its branch checkout). Idempotent — safe to call twice and on
  // the error path. Leaves the pushed branch on origin (the PR needs it).
  cleanup() {
    if (!this.dir) return;
    const dir = this.dir;
    this.dir = null;
    try { this.#rootGit(['worktree', 'remove', '--force', dir]); }
    catch { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone already */ } }
    try { this.#rootGit(['worktree', 'prune']); } catch { /* best effort */ }
  }
}

export class ScratchRepo {
  constructor({ root, log = () => {} }) {
    this.root = root;
    this.log = log;
  }

  pruneStale() { /* nothing to prune for scratch dirs */ }

  build(slug) {
    return new ScratchBuild({ root: this.root, slug, log: this.log });
  }
}

class ScratchBuild {
  constructor({ root, slug, log }) {
    this.dir = join(root, buildTag(slug)); // each task its own subdir
    this.log = log;
    this.before = new Map();
  }

  #snapshot() {
    const m = new Map();
    for (const f of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      try { m.set(f, statSync(join(this.dir, f)).mtimeMs); } catch {}
    }
    return m;
  }

  prepare() {
    mkdirSync(this.dir, { recursive: true });
    this.before = this.#snapshot();
  }

  hasChanges() {
    const after = this.#snapshot();
    for (const [f, t] of after) if (!this.before.has(f) || this.before.get(f) !== t) return true;
    return false;
  }

  // Mirror of SandboxBuild.changedFiles() for the no-git path: the top-level files this build
  // added or touched. Lets the publish test exercise the real gallery code without a checkout.
  changedFiles() {
    const after = this.#snapshot();
    const files = [];
    for (const [f, t] of after) {
      if (!this.before.has(f) || this.before.get(f) !== t) files.push({ rel: f, abs: join(this.dir, f) });
    }
    return files;
  }

  finalize() { return { verified: this.hasChanges() }; }

  cleanup() { /* tests own their scratch root */ }
}
