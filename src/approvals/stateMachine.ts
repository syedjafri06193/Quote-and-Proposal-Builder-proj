/**
 * The quote lifecycle state machine (design guide §8.2). State is derived by
 * folding the append-only event log; the stored `quotes.state` column is a
 * denormalization that must always equal the fold.
 */

export type QuoteState =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SENT'
  | 'VIEWED'
  | 'SIGNED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'VOIDED'
  | 'CLOSED_WON';

export type QuoteEventType =
  | 'created'
  | 'edited' // new version; payload.material says whether the fingerprint changed
  | 'repriced'
  | 'submitted'
  | 'auto-approved'
  | 'approval-decided'
  | 'approved' // plan complete
  | 'rejected'
  | 'recalled'
  | 'escalated'
  | 'document-generated'
  | 'sent'
  | 'viewed'
  | 'signed'
  | 'declined'
  | 'expired'
  | 'voided'
  | 'closed-won'
  | 'signature-mismatch'
  | 'cloned-from';

export const TERMINAL: ReadonlySet<QuoteState> = new Set(['CLOSED_WON', 'DECLINED', 'EXPIRED', 'VOIDED']);

/** Events that change state, and from which states they're legal. */
const TRANSITIONS: Partial<Record<QuoteEventType, { from: QuoteState[]; to: QuoteState | 'SAME' | 'EDIT' }>> = {
  created: { from: [], to: 'DRAFT' },
  edited: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], to: 'EDIT' },
  repriced: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], to: 'EDIT' },
  submitted: { from: ['DRAFT'], to: 'PENDING_APPROVAL' },
  'auto-approved': { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  'approval-decided': { from: ['PENDING_APPROVAL'], to: 'SAME' },
  escalated: { from: ['PENDING_APPROVAL'], to: 'SAME' },
  approved: { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  rejected: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  recalled: { from: ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'VIEWED'], to: 'DRAFT' },
  'document-generated': { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], to: 'SAME' },
  sent: { from: ['APPROVED'], to: 'SENT' },
  viewed: { from: ['SENT'], to: 'VIEWED' },
  signed: { from: ['SENT', 'VIEWED'], to: 'SIGNED' },
  'signature-mismatch': { from: ['SENT', 'VIEWED'], to: 'SAME' },
  declined: { from: ['SENT', 'VIEWED'], to: 'DECLINED' },
  expired: { from: ['SENT', 'VIEWED'], to: 'EXPIRED' },
  voided: { from: ['SENT', 'VIEWED', 'APPROVED'], to: 'VOIDED' },
  'closed-won': { from: ['SIGNED'], to: 'CLOSED_WON' },
  'cloned-from': { from: ['DRAFT'], to: 'SAME' },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: QuoteState | null,
    readonly event: QuoteEventType,
  ) {
    super(`cannot apply "${event}" to a quote in state ${from ?? '(none)'}`);
    this.name = 'InvalidTransitionError';
  }
}

export type FoldableEvent = { type: QuoteEventType; payload: Record<string, unknown> };

/** Next state, or throws. `edited` goes to DRAFT unless the change was not material and the quote was APPROVED. */
export function nextState(cur: QuoteState | null, e: FoldableEvent): QuoteState {
  const t = TRANSITIONS[e.type];
  if (!t) throw new InvalidTransitionError(cur, e.type);
  if (cur === null) {
    if (e.type !== 'created') throw new InvalidTransitionError(cur, e.type);
    return 'DRAFT';
  }
  if (!t.from.includes(cur)) throw new InvalidTransitionError(cur, e.type);
  if (t.to === 'SAME') return cur;
  if (t.to === 'EDIT') return cur === 'APPROVED' && e.payload.material === false ? 'APPROVED' : 'DRAFT';
  return t.to;
}

export function canApply(cur: QuoteState | null, e: FoldableEvent): boolean {
  try {
    nextState(cur, e);
    return true;
  } catch {
    return false;
  }
}

export function fold(events: readonly FoldableEvent[]): QuoteState {
  let s: QuoteState | null = null;
  for (const e of events) s = nextState(s, e);
  if (s === null) throw new Error('no events');
  return s;
}
