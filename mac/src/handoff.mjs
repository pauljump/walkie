// "Continue in another subscription": a new conversation, possibly on another CLI, that picks up where
// this one is. It carries the conversation itself (what you and the agent said, newest last), not a
// model-written summary, so it costs no quota and works even when the old subscription is out of it.

const speaker = { user: 'Me', text: 'Agent' };
export const MESSAGE_MARK = '[My message]';

// What was said, newest last, within `max` characters (older messages drop first).
export function excerpt(events = [], max = 16000) {
  const lines = events.filter((e) => speaker[e.kind] && e.text?.trim()).map((e) => `${speaker[e.kind]}: ${unwrap(e.text).trim()}`);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = `${lines[i]}\n\n${out}`;
    if (next.length > max) break;
    out = next;
  }
  return out.trim();
}

// A message that was itself a hand-off carries the older transcript; keep only what was typed.
const unwrap = (text) => { const at = text.indexOf(`\n\n${MESSAGE_MARK}\n`); return at >= 0 ? text.slice(at + MESSAGE_MARK.length + 3) : text; };

// "Send to projects": the turn that asks a conversation's agent to split what was agreed into one
// self-contained brief per project, as JSON the phone turns into a plan you review before anything starts.
export const PLAN_MARK = '[Walkie: send to projects]';
export function planPrompt(projects) {
  return [
    PLAN_MARK,
    'Turn what we agreed in this conversation into separate pieces of work, one per project, so each can run in its own session with no access to this conversation.',
    'Use only these project folders (absolute paths):',
    projects.map((p) => `- ${p}`).join('\n'),
    'Reply with only this JSON and nothing else:',
    '```json\n{"tasks":[{"project":"/absolute/path","title":"a short title","brief":"everything that session needs to do the work on its own: the goal, what we decided and why, constraints, and what done looks like"}]}\n```',
    'One task per project (combine work for the same project). Leave out anything we did not agree to do. If nothing is ready to hand off, reply {"tasks":[]}.',
  ].join('\n\n');
}

// The first message of the new conversation. The phone shows the head as a quiet note and only your
// words as a bubble (WalkiePrompt.split in the app).
export function handoffText({ from, title, cwd, events, text }) {
  const said = excerpt(events);
  const head = `[Continued from a ${from} conversation${title ? `: "${title.slice(0, 80)}"` : ''}]`;
  return [
    head,
    `We were working in ${cwd}. Here is the conversation so far, oldest first. Pick it up from there; don't redo finished work.`,
    said || '(nothing was said yet)',
    `${MESSAGE_MARK}\n${text}`,
  ].join('\n\n');
}
