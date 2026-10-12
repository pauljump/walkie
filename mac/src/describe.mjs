// Turning agent tool calls into something readable on a phone: a one-line title, optional detail,
// and a diff when the call edits a file. Shared by both adapters so Claude's `Edit` and Codex's
// `fileChange` render the same way.

const MAX_OUT = 4000;

export function clip(text, max = MAX_OUT) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

function lines(prefix, text) {
  return String(text ?? '').split('\n').map((l) => prefix + l).join('\n');
}

export function editDiff(path, oldText, newText) {
  return clip(`--- ${path}\n+++ ${path}\n${lines('-', oldText)}\n${lines('+', newText)}`, 12000);
}

const short = (p) => String(p ?? '').replace(/^\/Users\/[^/]+\//, '~/');

// Claude Code tool_use → { title, detail?, diff? }
export function describeClaudeTool(name, input = {}) {
  switch (name) {
    case 'Bash': return { title: `$ ${input.command ?? ''}`, detail: input.description };
    case 'Read': return { title: `Read ${short(input.file_path)}` };
    case 'Write': return { title: `Write ${short(input.file_path)}`, diff: clip(lines('+', input.content), 12000) };
    case 'Edit': return { title: `Edit ${short(input.file_path)}`, diff: editDiff(short(input.file_path), input.old_string, input.new_string) };
    case 'MultiEdit': return {
      title: `Edit ${short(input.file_path)}`,
      diff: (input.edits || []).map((e) => editDiff(short(input.file_path), e.old_string, e.new_string)).join('\n'),
    };
    case 'NotebookEdit': return { title: `Edit ${short(input.notebook_path)}`, diff: clip(lines('+', input.new_source), 12000) };
    case 'Glob': return { title: `Find ${input.pattern}`, detail: input.path && short(input.path) };
    case 'Grep': return { title: `Search "${input.pattern}"`, detail: input.path && short(input.path) };
    case 'WebFetch': return { title: `Fetch ${input.url}` };
    case 'WebSearch': return { title: `Search web: ${input.query}` };
    case 'Task':
    case 'Agent': return { title: `Agent: ${input.description ?? input.subagent_type ?? 'task'}`, detail: clip(input.prompt, 1500) };
    case 'TodoWrite': return {
      title: 'Update todos',
      detail: (input.todos || []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '·'} ${t.content}`).join('\n'),
    };
    case 'ExitPlanMode': return { title: 'Plan ready', detail: clip(input.plan, 12000) };
    case 'Skill': return { title: `Skill: ${input.skill ?? input.command ?? ''}` };
    default: {
      const json = JSON.stringify(input);
      return { title: name.replace(/^mcp__/, '').replace(/__/g, ' · '), detail: json && json !== '{}' ? clip(json, 1500) : undefined };
    }
  }
}

// Claude tool_result content → plain text
export function resultText(content) {
  if (typeof content === 'string') return clip(content);
  if (Array.isArray(content)) {
    return clip(content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n'));
  }
  return '';
}

// Codex fileChange changes[] → one diff
export function codexDiff(changes = []) {
  return clip(changes.map((c) => `--- ${short(c.path)} (${c.kind?.type ?? 'update'})\n${c.diff ?? ''}`).join('\n'), 12000);
}

export { short as shortPath };
