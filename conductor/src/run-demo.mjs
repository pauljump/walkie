import { Conductor } from './conductor.mjs';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';

// Proves the EM conductor kernel: two Director directives, one to a Claude worker
// and one to a Codex worker, each gated on verification, with the EM surfacing only
// verified signal. This is the talk -> build -> review loop in miniature, end to end.

const WORK = '/tmp/walkie-conductor-demo';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const c = new Conductor({ workspace: 'walkie-conductor-demo', cwd: WORK, log });
await c.start();

log('--- Director directive 1 -> Claude worker (Theo) ---');
await c.dispatch({
  name: 'Theo',
  engine: 'claude',
  model: 'sonnet',
  directive: 'Create a file named report.md containing a one-paragraph, plain-English description of what a "walking standup" is.',
  verify: () => existsSync(`${WORK}/report.md`),
});

log('--- Director directive 2 -> Codex worker (Cora) ---');
await c.dispatch({
  name: 'Cora',
  engine: 'codex',
  directive: 'Create a file named ping.txt whose only contents are the single word: pong',
  verify: () => existsSync(`${WORK}/ping.txt`) && readFileSync(`${WORK}/ping.txt`, 'utf8').toLowerCase().includes('pong'),
});

log('=== what the EM surfaced to the Director (verified signal only) ===');
for (const s of c.surfaced) {
  log(`  • [${s.kind}] ${s.from} (${s.engine}) verified=${s.verified}: ${s.text.slice(0, 100)}`);
}
const allVerified = c.surfaced.length === 2 && c.surfaced.every((s) => s.verified);
log(allVerified ? '✅ conductor kernel works: both directives built + verified + surfaced' : '❌ a directive failed its gate');
process.exit(allVerified ? 0 : 4);
