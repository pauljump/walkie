// Proof that a web build SHIPS LIVE — the deploy half of the loop.
// Exercises the gallery module end-to-end with NO git, NO API, NO network: build some files in
// a scratch dir, pick the demo bundle, stage its bytes, publish into a throwaway gallery, and
// assert the page + manifest card landed. Also unit-checks the path logic that rebases a demo
// to its slug root.
//
//   node test/publish.mjs

import { ScratchRepo } from '../src/workspace.mjs';
import { pickDemoBundle, stageBundle, deriveMeta, publishDemo } from '../src/gallery.mjs';
import { clearConfigCache } from '../src/config.mjs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Neutral fixtures — no personal repo/domain baked into a public test suite.
const PR_URL = 'https://github.com/example-user/your-sandbox/pull/9';

// Isolate from the operator's real ~/.walkie/config.json (which may set demoHost) — this test
// asserts the BAKED defaults, so point the config loader at a file that doesn't exist.
process.env.WALKIE_CONFIG_PATH = '/tmp/walkie-publish-test-no-config.json';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (label, ok) => { checks.push({ label, ok }); };

// ── 1. A real (scratch) build produces a landing page + asset + a non-web file ──────────────
const root = join(tmpdir(), 'walkie-publish-test');
const gallery = join(tmpdir(), 'walkie-publish-gallery');
rmSync(root, { recursive: true, force: true });
rmSync(gallery, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const repo = new ScratchRepo({ root, log });
const build = repo.build('curfew');
build.prepare();
writeFileSync(join(build.dir, 'index.html'), '<html><head><title>Curfew — One-Tap iPad Parental Control</title></head><body>hi</body></html>');
writeFileSync(join(build.dir, 'style.css'), 'body{color:#111}');
writeFileSync(join(build.dir, 'README.md'), '# not a web asset, should NOT ship');

// ── 2. Pick the bundle: web files only, README excluded ─────────────────────────────────────
const bundle = pickDemoBundle(build.changedFiles());
check('bundle found', !!bundle);
const dests = (bundle?.files ?? []).map((f) => f.destRel).sort();
check('bundle is index.html + style.css (README excluded)', JSON.stringify(dests) === JSON.stringify(['index.html', 'style.css']));

// ── 3. Title + slug come from the page ──────────────────────────────────────────────────────
const meta = deriveMeta({ html: readFileSync(bundle.entryAbs, 'utf8'), directive: 'Build a Curfew landing page' });
check('slug derived as "curfew"', meta.slug === 'curfew');
check('title carries through', /Curfew/.test(meta.title));

// ── 4a. Publish with NO public host configured (the default self-host case): files land, but
//        there's no live URL to promise — demoUrl is null and localPath points at the staged dir.
const staged = stageBundle(bundle);
delete process.env.WALKIE_DEMO_HOST;
clearConfigCache();
const local = publishDemo({ slug: meta.slug, title: meta.title, blurb: 'Build a Curfew landing page', prUrl: PR_URL, files: staged, galleryDir: gallery });
check('local-only: demoUrl is null when no host set', local.demoUrl === null);
check('local-only: localPath points at the staged demo dir', local.localPath === join(gallery, 'public', 'curfew'));

// ── 4b. Publish WITH a public host configured: demoUrl is the slug URL on that host. ──────────
process.env.WALKIE_DEMO_HOST = 'demos.example.com';
clearConfigCache();
const { demoUrl } = publishDemo({ slug: meta.slug, title: meta.title, blurb: 'Build a Curfew landing page', prUrl: PR_URL, files: staged, galleryDir: gallery });
check('demoUrl is the slug URL on the configured host', demoUrl === 'https://demos.example.com/curfew/');
check('index.html written to gallery', existsSync(join(gallery, 'public', 'curfew', 'index.html')));
check('style.css written to gallery', existsSync(join(gallery, 'public', 'curfew', 'style.css')));
check('README NOT shipped', !existsSync(join(gallery, 'public', 'curfew', 'README.md')));

const manifest = JSON.parse(readFileSync(join(gallery, 'index.json'), 'utf8'));
const card = manifest.find((c) => c.slug === 'curfew');
check('manifest card present with PR link', !!card && card.pr === PR_URL);

// ── 5. Re-publishing the same slug dedupes (iterating on a demo updates it, not duplicates) ──
publishDemo({ slug: 'curfew', title: meta.title, blurb: 'v2', files: staged, galleryDir: gallery });
const manifest2 = JSON.parse(readFileSync(join(gallery, 'index.json'), 'utf8'));
check('re-publish dedupes by slug', manifest2.filter((c) => c.slug === 'curfew').length === 1);

// ── 6. Pure path logic: a demo in a subdir rebases to the slug root; an oddly-named entry ────
const sub = pickDemoBundle([
  { rel: 'site/index.html', abs: '/x/site/index.html' },
  { rel: 'site/app.js', abs: '/x/site/app.js' },
  { rel: 'notes.md', abs: '/x/notes.md' },
]);
const subDests = sub.files.map((f) => f.destRel).sort();
check('subdir demo rebased to root', JSON.stringify(subDests) === JSON.stringify(['app.js', 'index.html']));
const renamed = pickDemoBundle([{ rel: 'landing.html', abs: '/x/landing.html' }]);
check('oddly-named entry renamed to index.html', renamed.files[0].destRel === 'index.html');
check('no html → no demo', pickDemoBundle([{ rel: 'server.js', abs: '/x/server.js' }]) === null);

// ── cleanup + report ────────────────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });
rmSync(gallery, { recursive: true, force: true });

console.log('\n=================== RESULTS ===================');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.label}`);
console.log('==============================================');
const pass = checks.every((c) => c.ok);
console.log(pass ? '✅ PUBLISH PIPELINE WORKS (build → bundle → live gallery)' : '❌ publish pipeline broken');
process.exit(pass ? 0 : 1);
