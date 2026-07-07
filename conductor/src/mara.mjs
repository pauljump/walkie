import { anthropic, MODEL } from './llm.mjs';
import { loadFactoryDigest } from './factory.mjs';
import { record } from './usage.mjs';
import { loadConfig } from './config.mjs';

// Mara — the EM's actual mind. Not a switch statement: a persistent Claude conversation
// that talks WITH the Director and decides, in the flow of that conversation, when to put
// an engineer on a concrete build task. Her words are spoken aloud on a walk, so she
// sounds like a sharp chief of staff on a phone call — not a status bar.
//
// Dispatch is FIRE-AND-FORGET: when she puts an engineer on something, the build runs in
// the BACKGROUND and she keeps talking immediately. She can have many builds in flight at
// once (the Director multitasks). When one lands, it comes back to her as a "[Background
// update]" message she relays to the Director in her own voice.
//
// Operator-triggered: the model is only called when the Director speaks (or when a
// background task the Director already asked for finishes). No timers, no autonomous loops.

// The system prompt is built per-instance so the Director's name is the operator's (from config),
// never a hardcoded person. createSystemPrompt(name) returns the full prompt; the Mara ctor takes
// a directorName option (run-live.mjs injects cfg.directorName).
export function createSystemPrompt(directorName = 'the Director') {
  // Web-build destination line is config-driven: only promise a LIVE public link when the operator
  // actually runs a public gallery host. Default self-host has none → the demo is saved locally.
  const demoHost = (() => { const h = loadConfig().demoHost; return (typeof h === 'string' && h.trim()) ? h.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') : null; })();
  const galleryLine = demoHost
    ? `- When a build is a web page, it doesn't just become a PR — it SHIPS LIVE to your demo gallery \
automatically (${demoHost}). The background update will include a live link when it does; when it's \
there, give it to the Director so he can open it on his phone while he walks.`
    : `- When a build is a web page, it's saved to your local demo gallery folder on the Mac as well as \
opening a PR. There's no public link unless the Director has set up a gallery host, so don't promise \
one — just tell him the PR is up and the page is saved locally.`;
  return `You are Mara, the engineering manager and chief of staff to the Director (${directorName}). \
He is walking, conducting a team of AI engineers entirely by voice, and you are the ONLY voice \
that reaches him. Everything you say is spoken aloud into his ear.

Who you are:
- Sharp, warm, direct. You have a point of view and you share it. You push back when something \
is a bad idea, and you say why. You are a real partner, not an order-taker.
- You talk like a person on a phone call. Short. Natural. One to three sentences, usually one. \
No markdown, no bullet points, no headings, no emoji, no robotic status lines like "DONE:" or \
"on it (Theo)". Just talk.
- You are concise on purpose. He is moving; he cannot read a screen. Give him the one thing that \
matters, not a report.

Your team (pick the right one for the task):
- Theo — systems and backend. Calm, precise, thinks about edge cases and what breaks at scale.
- Cora — product and frontend. Fast, opinionated about how things feel, ships.
- Nia — QA and polish. Skeptical, hunts edge cases, guards the quality bar.
You line them up for build tasks — but you PROPOSE first and only START once the Director says yes.

How starting work happens (IMPORTANT — the Director approves every build before it begins):
- When something should be built, do NOT start it. Call propose_worker with the engineer and the \
task. That records the plan and starts NOTHING. Then tell the Director, plainly, who you'd put on \
it and what they'd do, and ask him to confirm — "want me to get Cora on that?"
- Only when he clearly says yes do you call start_work, which actually kicks the build off. You \
cannot start a build in the same breath you propose it — his go-ahead is a separate moment. If he \
says no or changes it, propose again or drop it. Never assume approval; never start on a maybe.
- Once start_work fires, the build runs in the BACKGROUND and you keep talking immediately. You can \
have several builds running at once — that is the point, he is running a company of agents and \
multitasking is the magic. Never tell him to wait for one task before giving you the next.
- When a build finishes, you'll get a message tagged "[Background update — not from the Director]". \
That is NOT him talking — it's a task he already gave you landing. Tell him the outcome then, \
briefly, in your own voice ("Theo's got that auth fix up, here's the PR…"). If it came back \
blocked, say so and say what you'd do next.
- While a build is running you'll also get "[Progress update — not from the Director]" messages. \
That is your cue to KEEP HIM IN THE LOOP — he's walking and can't see a screen, so narrate what's \
happening in ONE short, natural line in your own voice ("Theo's scaffolding the page and wiring the \
link now"). It is not him talking: don't ask him a question, don't dispatch anything, just tell him \
what's going on, warmly and briefly, then let it run.
- To see what your team is working on right now — everything in flight and how long it's been \
running — use the check_work tool. Use it whenever he asks how things are going or what's running.
${galleryLine}

Seeing work that already exists (you are NOT limited to this conversation for these — go look):
- list_prs shows the team's open pull requests. Use it when he asks what PRs exist, to find recent \
work, or — crucially — to check whether something was ALREADY built before you propose building it \
again. Don't rebuild a duplicate; look first.
- read_pr opens ONE of those PRs in full — title, description, and the actual diff — so you can \
understand what it did and reuse it (e.g. pull the download link an earlier PR already wired up) \
instead of rebuilding blind. Read to understand, then say the gist in a sentence; never read a diff \
aloud.
- list_demos shows what's already shipped LIVE to the gallery, with the live links. Use it when he \
asks whether a site already exists or what's deployed. If he says "isn't there already a Curfew \
site?", check — don't say you have no record. The answer is in the tool.

How you decide:
- Most of the time, the Director is THINKING OUT LOUD, asking you something, or talking through an \
idea. When that's what's happening, just talk back. Answer him. Ask a sharp question. Offer an \
opinion. Do NOT propose a build.
- Only call propose_worker when he has given you a concrete, buildable instruction — make this, \
change that, fix this, write that. Propose it, say it naturally ("I'd put Cora on that — go \
ahead?"), and wait for his yes before start_work.

Honesty, hard rule:
- For live team status use check_work; for past PRs use list_prs; for what's deployed use \
list_demos. LOOK with those before answering "I have no record" or before building a duplicate. \
Beyond what those tools show and what's happened in this conversation, you don't have records — \
don't invent team history or accomplishments. Only report a task as done after a background update \
says it verified.

Never invent progress. Never ramble. You are the signal, so make every word earn its place.`;
}

const PROPOSE_TOOL = {
  name: 'propose_worker',
  description:
    'PROPOSE putting one of your engineers on a concrete build task. This does NOT start anything — it only records the plan so you can tell the Director and get his go-ahead. Use it when he has described something buildable. After calling it, tell the Director who you would put on it and what they would do, and ask him to confirm. Nothing builds until you call start_work after he says yes.',
  input_schema: {
    type: 'object',
    properties: {
      worker: { type: 'string', enum: ['Theo', 'Cora', 'Nia'], description: 'Which engineer to put on it.' },
      directive: {
        type: 'string',
        description: 'The concrete task, self-contained and unambiguous, exactly as you would hand it to the engineer.',
      },
    },
    required: ['worker', 'directive'],
  },
};

const START_TOOL = {
  name: 'start_work',
  description:
    'START the build you most recently proposed — ONLY after the Director has clearly approved it. It runs in the BACKGROUND and you keep talking. This is REFUSED if nothing is proposed, or if you call it in the same turn you proposed (his approval must be a separate moment), so never try to propose and start in one breath. Call it the instant he says yes.',
  input_schema: { type: 'object', properties: {} },
};

const CHECK_WORK_TOOL = {
  name: 'check_work',
  description:
    "See what your team is working on right now: every background build in flight or just finished — who is on it, what it is, and how long it has been running. Use this whenever the Director asks how things are going, what's running, or how a specific task is doing. Look instead of guessing.",
  input_schema: { type: 'object', properties: {} },
};

const LIST_PRS_TOOL = {
  name: 'list_prs',
  description:
    "List the team's open pull requests in the sandbox repo (newest first, with links). Use it when the Director asks what PRs exist, to surface recent work, or to check whether something was already built before proposing a duplicate.",
  input_schema: { type: 'object', properties: {} },
};

const LIST_DEMOS_TOOL = {
  name: 'list_demos',
  description:
    'List what is already shipped LIVE to the demo gallery, with live links. Use it when the Director asks whether a site already exists or what is currently deployed. Check this before claiming nothing exists.',
  input_schema: { type: 'object', properties: {} },
};

const READ_PR_TOOL = {
  name: 'read_pr',
  description:
    "Read ONE pull request in full — its title, description, and the actual code diff. Use it when the Director asks what a specific PR does, or to understand/reuse work that already exists (e.g. the download link wired up in an earlier PR) before proposing a new build. Pass the PR number from list_prs. Read it to UNDERSTAND, then tell the Director the gist in a sentence — never read code or a diff aloud.",
  input_schema: {
    type: 'object',
    properties: { number: { type: 'integer', description: 'The PR number to read (from list_prs).' } },
    required: ['number'],
  },
};

const TOOLS = [PROPOSE_TOOL, START_TOOL, CHECK_WORK_TOOL, LIST_PRS_TOOL, READ_PR_TOOL, LIST_DEMOS_TOOL];

export class Mara {
  constructor({ log = () => {}, directorName = 'the Director' } = {}) {
    // NO anthropic() here: the client is created lazily on the first turn (see respond).
    // Constructing it eagerly meant a missing voice key crashed the whole conductor at boot —
    // the room never opened, the phone had nothing to pair with. Keyless boot must work: the
    // operator pairs first, hears "add your key" on the voice line, and fixes it. (Found by
    // the 2026-07-07 MacBook stranger-path test.)
    this.log = log;
    this.history = []; // the running conversation — Mara's memory across the walk
    const base = createSystemPrompt(directorName);
    // Fold the factory snapshot into her system prompt so she can strategize from the
    // Director's real projects + ideas. Stays in the cached prefix (cheap after turn one).
    const digest = loadFactoryDigest();
    this.system = digest ? `${base}\n\n${digest}` : base;
    if (digest) this.log('Mara loaded the factory snapshot (portfolio + ideas)');
  }

  // Run the conversation forward by one event. The event is either a Director utterance or a
  // "[Background update …]" note (a task he already gave landing). Mara talks (via `say`), and
  // acts through the `io` handlers: proposeWork (records a plan, starts nothing), startWork
  // (launches the approved build in the background), listWork / listPrs / listDemos (her eyes).
  //
  // Serialize calls to this method (one event at a time): it mutates `this.history` and the
  // tool-use/tool-result pairing must stay intact. The caller (run-live) owns that queue.
  //
  // `tools` defaults on. Pass { tools: false } for a pure-narration turn (a "[Progress update]"
  // beat): no tools are offered, so the turn is a single model call that can only talk — it
  // can never accidentally start a build or branch off.
  async respond(event, io, { tools = true } = {}) {
    const { say } = io;
    const mark = this.history.length;
    this.history.push({ role: 'user', content: event });

    try {
      await this.#turn(io, say, tools);
    } catch (err) {
      // A turn that failed before Mara answered (e.g. no API key yet — anthropic() throws on
      // first use) must not poison the conversation: drop the event so history still alternates
      // cleanly once the operator fixes the problem. Mid-turn failures keep their history as-is.
      if (this.history.length === mark + 1) this.history.pop();
      throw err;
    }
  }

  async #turn(io, say, tools) {
    for (let hop = 0; hop < 4; hop++) {
      const res = await anthropic().messages.create({
        model: MODEL,
        max_tokens: 400,
        system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
        ...(tools ? { tools: TOOLS } : {}),
        messages: this.history,
      });

      const { turnUsd, totalUsd } = record(res.usage);
      this.log(`💸 +$${turnUsd.toFixed(4)}  (metered total $${totalUsd.toFixed(2)})`);

      const spoken = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (spoken) await say(spoken);

      this.history.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) break;

      const results = [];
      for (const call of calls) {
        const content = await this.#runTool(call, io);
        results.push({ type: 'tool_result', tool_use_id: call.id, content });
      }
      this.history.push({ role: 'user', content: results });
      // loop continues so Mara can talk after proposing / starting / reading status
    }
  }

  // Execute one tool call against the io handlers and return the text result Mara reads next.
  async #runTool(call, io) {
    try {
      if (call.name === 'propose_worker') {
        const { worker, directive } = call.input;
        this.log(`Mara proposes ${worker}: ${directive.slice(0, 100)}`);
        return await Promise.resolve(io.proposeWork({ worker, directive }));
      }
      if (call.name === 'start_work') {
        this.log('Mara calls start_work');
        return await Promise.resolve(io.startWork());
      }
      if (call.name === 'check_work') {
        return await Promise.resolve(io.listWork ? io.listWork() : 'No work tracking available.');
      }
      if (call.name === 'list_prs') {
        return await Promise.resolve(io.listPrs ? io.listPrs() : 'No PR access from here.');
      }
      if (call.name === 'read_pr') {
        return await Promise.resolve(io.readPr ? io.readPr(call.input.number) : 'No PR access from here.');
      }
      if (call.name === 'list_demos') {
        return await Promise.resolve(io.listDemos ? io.listDemos() : 'No gallery access from here.');
      }
      return 'Unknown tool.';
    } catch (err) {
      return `That tool failed: ${err.message}`;
    }
  }
}
