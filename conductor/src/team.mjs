import { anthropic, MODEL } from './llm.mjs';
import { record } from './usage.mjs';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The team — Theo, Cora, Nia — as PERSISTENT characters, not throwaway workers.
// Each engineer has a frozen persona (walkie/team/<name>.md, committed) and a live
// memory/track-record that accrues across walks. The memory lives OUTSIDE the repo
// (~/.walkie/team/<name>.md) so the Mac-mini main-sync (reset --hard) can't wipe it.
//
// An engineer is a face, not a builder: the real file work is done by a harness worker
// (see conductor.dispatch). The engineer acknowledges the task and reports the outcome in
// their own voice, in the #work room the Director can watch.

const HERE = dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR = join(HERE, '..', '..', 'team');           // walkie/team (frozen personas)
const MEMORY_DIR = join(homedir(), '.walkie', 'team');         // accrues; main-sync safe
const ROSTER = ['theo', 'cora', 'nia'];

export class Engineer {
  constructor(slug, { log = () => {} } = {}) {
    this.slug = slug;
    this.log = log;
    this.persona = readFileSync(join(PERSONA_DIR, `${slug}.md`), 'utf8').trim();
    this.name = this.persona.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? slug;
    this.memoryPath = join(MEMORY_DIR, `${slug}.md`);
    mkdirSync(MEMORY_DIR, { recursive: true });
    if (!existsSync(this.memoryPath)) {
      appendFileSync(this.memoryPath, `# ${this.name} — track record\n\n`);
    }
  }

  // Last few log entries, freshest last — Theo remembers what he's built across walks.
  recentTrack(n = 6) {
    const lines = readFileSync(this.memoryPath, 'utf8').split('\n').filter((l) => l.startsWith('- '));
    return lines.slice(-n);
  }

  #system() {
    const track = this.recentTrack();
    const record = track.length ? track.join('\n') : 'This is your first task with the Director — no track record yet.';
    return `${this.persona}

Your track record (recent, oldest first):
${record}

You are in the team's #work room, where Mara (your EM) hands out work and the Director watches.
Reply with ONE short, natural line in your own voice — spoken-aloud brief. No markdown, no preamble.`;
  }

  async #line(prompt, maxTokens) {
    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: this.#system(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    record(res.usage);
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  }

  // Mara just handed you the task — acknowledge it and give your one-line plan.
  ack(directive) {
    return this.#line(`Mara just handed you this: "${directive}". Acknowledge it and say your one-line plan.`, 120);
  }

  // The build finished — report the outcome to the room, honestly, in your voice.
  report({ directive, verified, notes }) {
    const outcome = verified
      ? 'It verified — the code really changed.'
      : 'It did NOT verify — nothing buildable landed.';
    return this.#line(
      `You took on: "${directive}". ${outcome} Build notes: ${notes || 'none'}. Give your one-line report to the room.`,
      150,
    );
  }

  // Persist what happened so it shows up in your track record next walk.
  remember({ directive, verified }) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const task = directive.replace(/\s+/g, ' ').trim().slice(0, 80);
    appendFileSync(this.memoryPath, `- [${stamp}] ${task} — ${verified ? 'shipped' : 'blocked'}\n`);
  }
}

export function loadTeam(opts = {}) {
  const team = new Map();
  for (const slug of ROSTER) {
    const eng = new Engineer(slug, opts);
    team.set(eng.name.toLowerCase(), eng);
  }
  return team; // keyed by lowercased name: "theo" -> Engineer
}
