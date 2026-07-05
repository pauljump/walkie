// The confirmation gate: no engineer starts building until the Director has given the word.
//
// Mara works in two steps now. She PROPOSES a build (records the plan, starts nothing), tells
// the Director what she'd do, and only STARTS it after he confirms. The enforcement that makes
// this real — not just a prompt she might ignore — is the turn rule: a proposal is stamped with
// the Director turn it was made on, and a start is only allowed on a LATER Director turn. Mara
// cannot manufacture a second Director utterance, so she cannot propose-and-launch in one breath.
// His go-ahead is a structurally separate moment.
//
//   gate.propose({ worker, directive, turn })   // turn = the Director-turn id it was proposed on
//   gate.start({ turn })  -> { ok, task } | { ok:false, reason }

export class ConfirmGate {
  constructor() {
    this.pending = null; // the single proposal awaiting the Director's yes
  }

  get hasPending() {
    return !!this.pending;
  }

  // Record a proposal. Overwrites any earlier un-confirmed one (the latest plan wins).
  propose({ worker, directive, turn }) {
    this.pending = { worker, directive, turn: turn ?? null };
    return this.pending;
  }

  // Try to release the pending proposal into a real build. Allowed ONLY when:
  //   • something is actually proposed, and
  //   • we're on a Director turn (a real human utterance), and
  //   • that turn is DIFFERENT from the one the proposal was made on (a genuine second moment).
  // On success the proposal is consumed and the task returned; otherwise a reason Mara can voice.
  start({ turn }) {
    if (!this.pending) return { ok: false, reason: 'nothing-proposed' };
    if (!turn) return { ok: false, reason: 'not-director-turn' };
    if (this.pending.turn === turn) return { ok: false, reason: 'same-turn' };
    const task = { worker: this.pending.worker, directive: this.pending.directive };
    this.pending = null;
    return { ok: true, task };
  }

  // Drop a pending proposal (the Director said no / changed his mind).
  cancel() {
    this.pending = null;
  }
}
