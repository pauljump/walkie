import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from './config.mjs';

// The other half of the deploy loop: take a finished web build and SHIP IT LIVE.
//
// A separate, out-of-repo server (`~/walkie-demos`, port 7650) already serves two hostnames
// off one process and a manifest (the jumpbankdemo / rexair-showcase pattern):
//   walkiesandbox.polyfeeds.dev      → the gallery wall of everything Walkie has shipped
//   walkiedemo.polyfeeds.dev/<slug>  → the rendered page for one demo
// `index.json` drives the gallery. This module is the "conductor's deploy tool" that server
// was always waiting for: it drops a build's web files into `public/<slug>/` and appends the
// card to `index.json`. Pure filesystem, zero deps, no network call — fits the no-autonomous-
// API rule (it's triggered by a build the Director already asked for).
//
// Kept deliberately out of the repo tree: the Mac-mini main-sync does `reset --hard` + `clean`,
// which would wipe an in-repo gallery (see the rexairdemo / jumpbankdemo showcases).

// The gallery dir is per-user (config.galleryDir; WALKIE_GALLERY_DIR still overrides via config).
// Resolved lazily so a test that sets WALKIE_CONFIG_PATH/WALKIE_GALLERY_DIR before importing this
// module gets the right path, and so importing the module never forces a config read.
function galleryDirDefault() { return loadConfig().galleryDir; }

// Public hosts are per-user config, NOT hardcoded (a hardcoded domain leaked one person's
// infrastructure into every install). Default null → local-only: we still stage the files, but
// there's no live URL to hand out, so the helpers return null and callers report the local path.
function trimHost(h) { return (typeof h === 'string' && h.trim()) ? h.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') : null; }
function demoHost() { return trimHost(loadConfig().demoHost); }
function galleryHost() { return trimHost(loadConfig().galleryHost); }

// The live URL for a shipped demo, or null when no public host is configured (the common
// self-host case). Exported so run-live can render the same URL the EM speaks.
export function publicDemoUrl(slug, { host = demoHost() } = {}) {
  return host ? `https://${host}/${slug}/` : null;
}
export function publicGalleryUrl({ host = galleryHost() } = {}) {
  return host ? `https://${host}` : null;
}

// What's already shipped to the gallery (newest first), so Mara can SEE what's live instead of
// rebuilding a demo that already exists. Read-only; empty list if the gallery isn't there yet.
export function listPublishedDemos({ galleryDir = galleryDirDefault() } = {}) {
  try {
    const m = JSON.parse(readFileSync(join(galleryDir, 'index.json'), 'utf8'));
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}

// Files we'll serve as a demo. Anything else a build touched (READMEs, configs) is left out
// of the published bundle — the gallery is the *web page*, not the repo.
const WEB_EXTS = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.map', '.txt',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm',
]);
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // a demo page, not a data dump — stay sane in memory

function ext(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}
function isWeb(rel) {
  return WEB_EXTS.has(ext(rel));
}
// POSIX-style dirname on the repo-relative path (git always gives '/').
function relDir(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}
function underDir(rel, dir) {
  return dir === '' ? true : rel === dir || rel.startsWith(`${dir}/`);
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// Choose which changed files (if any) form a shippable web demo, and where each one lands in
// the published bundle. A demo is "a thing with an index" — so we anchor on an HTML entry:
//   • prefer a file literally named index.html (shallowest wins);
//   • else the shallowest .html, which we rename to index.html so the URL just works.
// Everything web under the entry's directory comes along (css/js/images), rebased so the
// entry sits at the slug root. No HTML touched in this build → null (it wasn't a web build).
//
//   changed: [{ rel, abs }]  →  { entryAbs, files: [{ destRel, abs }] } | null
export function pickDemoBundle(changed) {
  const htmls = (changed || []).filter((f) => ext(f.rel) === '.html');
  if (!htmls.length) return null;

  const depth = (f) => f.rel.split('/').length;
  const named = htmls.filter((f) => f.rel.toLowerCase().endsWith('index.html'));
  const pool = named.length ? named : htmls;
  const entry = pool.slice().sort((a, b) => depth(a) - depth(b) || a.rel.length - b.rel.length)[0];

  const base = relDir(entry.rel);
  const files = changed
    .filter((f) => isWeb(f.rel) && underDir(f.rel, base))
    .map((f) => {
      const rel = base === '' ? f.rel : f.rel.slice(base.length + 1);
      return { destRel: f === entry ? 'index.html' : rel, abs: f.abs };
    });

  // Guarantee an index.html at the root even if the entry was named oddly.
  if (!files.some((f) => f.destRel === 'index.html')) files.push({ destRel: 'index.html', abs: entry.abs });
  return { entryAbs: entry.abs, files };
}

// Pull a human title + a clean slug out of the page itself, falling back to the directive.
// "Curfew — One-Tap iPad Parental Control" → slug "curfew", which is the URL the Director hears.
export function deriveMeta({ html = '', directive = '' }) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  const title = (m ? m[1].trim() : '') || directive.replace(/\s+/g, ' ').trim().slice(0, 70) || 'demo';
  const head = title.split(/\s*[—–\-:|]\s*/)[0]; // first clause before a dash/pipe
  const slug = slugify(head) || slugify(directive) || 'demo';
  return { title, slug };
}

// Read a bundle's bytes NOW, while the build worktree still exists. The caller finalizes the
// build (which tears the worktree down) and only THEN calls publishDemo with these bytes — so
// the manifest card can carry the PR link without racing the cleanup.
//
//   bundle  →  [{ destRel, bytes }]   (throws if the bundle is implausibly large)
export function stageBundle(bundle) {
  let total = 0;
  const staged = bundle.files.map((f) => {
    const bytes = readFileSync(f.abs);
    total += bytes.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`demo bundle too large (>${MAX_BUNDLE_BYTES} bytes)`);
    return { destRel: f.destRel, bytes };
  });
  return staged;
}

// Write the staged files into the live gallery and add (or refresh) the card in index.json.
// Re-publishing the same slug overwrites it — iterating on a demo just updates the live page.
// Returns the links the Director will hear.
export function publishDemo({ slug, title, blurb = '', prUrl = null, files, deployedAt = null, galleryDir = galleryDirDefault() }) {
  if (!slug) throw new Error('publishDemo: slug required');
  if (!files?.length) throw new Error('publishDemo: no files to publish');

  const demoDir = join(galleryDir, 'public', slug);
  rmSync(demoDir, { recursive: true, force: true }); // drop any stale files from a prior deploy
  for (const f of files) {
    const dest = join(demoDir, f.destRel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.bytes);
  }

  const manifestPath = join(galleryDir, 'index.json');
  let manifest = [];
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = []; }
  if (!Array.isArray(manifest)) manifest = [];
  const card = {
    slug,
    title,
    blurb: blurb.replace(/\s+/g, ' ').trim().slice(0, 200),
    deployedAt: deployedAt ?? new Date().toISOString().slice(0, 10),
    ...(prUrl ? { pr: prUrl } : {}),
  };
  manifest = [card, ...manifest.filter((c) => c && c.slug !== slug)]; // newest first, deduped
  if (!existsSync(galleryDir)) mkdirSync(galleryDir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // demoUrl/galleryUrl are null when no public host is set; localPath always points at the
  // staged files so the caller can tell the Director where it landed even without a live URL.
  return { slug, localPath: demoDir, demoUrl: publicDemoUrl(slug), galleryUrl: publicGalleryUrl() };
}
