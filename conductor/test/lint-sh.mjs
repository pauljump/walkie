// lint-sh — guard against the macOS-bash multibyte crash class. $0, deterministic.
//
// THE BUG (real crash on a stock MacBook, 2026-07-07): a multibyte char (…, —, ✓) written
// DIRECTLY AFTER an unbraced $var makes macOS bash swallow the char's lead byte (0xe2) into
// the variable name; under `set -u` the resulting "$DESTâ" is unbound and the script aborts.
// It took down the public installer on the first real stranger-path test. Plain multibyte in
// strings is fine — only the $var-adjacent case kills. Fix at the site: brace it — "${DEST}…"
// or make the string ASCII. This lint fails on any shipped .sh containing the pattern.
//
// Run: npm run lint-sh   (also part of `npm run e2e` sanity via package.json if wired there)

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const conductor = join(here, '..');

// Every shell script we ship: the wizard + service scripts, the jail profile, and — when this
// runs inside the monorepo — the walkie.cc bootstrap installer next door. In the published
// tarball/repo the site dir may be absent; skip what isn't there.
const targets = [
  ...readdirSync(join(conductor, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => join(conductor, 'scripts', f)),
  join(conductor, 'src', 'jail-profile.sh'),
  join(conductor, '..', 'site', 'install.sh'),
];

const PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;
let bad = 0;
for (const file of targets) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; } // absent in published layouts
  text.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) {
      bad++;
      console.error(`${file}:${i + 1}: multibyte char directly after unbraced $var — brace it (\`\${VAR}\`) or use ASCII:\n  ${line.trim()}`);
    }
  });
}

if (bad) { console.error(`\nlint-sh: ${bad} crash-pattern line(s). This aborts stock-macOS installs.`); process.exit(1); }
console.log('lint-sh: clean — no $var-adjacent multibyte in shipped shell scripts.');
