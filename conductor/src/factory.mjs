import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';

// Mara's eyes on the Director's world. A read-only snapshot of the factory — the project
// portfolio (what's alive, what's parked) and the ideas backlog — folded into her context
// so she can actually strategize about what to build instead of admitting she's blind.
//
// Loaded once at startup and cached in her system prompt. It's a snapshot, not live; on a
// restart she sees the current state. Read-only — she never writes here.

const HERE = dirname(fileURLToPath(import.meta.url));
// <root>/walkie/conductor/src/factory.mjs -> <root> (fallback when no config factoryRoot is set)
const DEFAULT_ROOT = join(HERE, '..', '..', '..');

// Resolve the factory root: config.factoryRoot (self-host; may be null = no factory), else the
// repo-relative default. Optional feature — an operator with no monorepo just gets no digest.
function resolveRoot() {
  const cfg = loadConfig();
  return cfg.factoryRoot || DEFAULT_ROOT;
}

function readCapped(path, max) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  return text.length > max ? text.slice(0, max) + '\n…(truncated)' : text;
}

// Returns a digest string for the system prompt, or '' if nothing is readable.
export function loadFactoryDigest({ root } = {}) {
  if (!root) root = resolveRoot();
  const portfolio = readCapped(join(root, 'brain', 'projects-kb', 'reports', 'portfolio.md'), 9000);
  const ideas = readCapped(join(root, 'brain', 'ideas', 'INDEX.md'), 5000);
  if (!portfolio && !ideas) return '';

  return [
    '=== THE DIRECTOR\'S FACTORY (read-only snapshot) ===',
    'You can see the Director\'s real projects and ideas below. When he asks what to build,',
    'what\'s worth picking up, or how something fits, reason from THIS — name real projects,',
    'weigh them, have a view. Do NOT invent projects or status beyond what\'s here. It is a',
    'snapshot; if he tells you something has changed, trust him over this.',
    portfolio ? `\n--- Project portfolio (signal-ranked; higher = more alive) ---\n${portfolio}` : '',
    ideas ? `\n--- Ideas backlog ---\n${ideas}` : '',
  ].filter(Boolean).join('\n');
}
