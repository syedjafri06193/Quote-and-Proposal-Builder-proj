/**
 * Approval chains (design guide §8). The abuse test comes first.
 */
import { describe, expect, test } from 'vitest';
import { ApprovalInvalidatedError } from '../src/app/errors.ts';
import { businessMinutesBetween, escalationDue, resolvePlan, approvalFingerprint } from '../src/approvals/approvals.ts';
import { fold, nextState, TERMINAL, InvalidTransitionError } from '../src/approvals/stateMachine.ts';
import { priceQuote } from '../src/pricing/pipeline.ts';
import { USERS } from '../src/seed/data.ts';
import { testApp, approvedQuote, managerApprovalInput, config, RS1, PB1 } from './helpers.ts';

const linesWithDiscount = (bp: number) => [
  { lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: bp },
  { lineId: 'L2', productId: 'onb', quantity: '1' },
];

describe('the abuse test: approve, edit the discount, try to send', () => {
  test('send is refused and names who must re-approve', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    expect(app.quotes.getQuote(id).quote.state).toBe('APPROVED');
    app.quotes.editQuote('alice', id, { lines: linesWithDiscount(3000) });
    const err = await app.quotes.send('alice', id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalInvalidatedError);
    expect((err as ApprovalInvalidatedError).message).toContain('Re-approval required from: Mike Okafor');
    expect((err as ApprovalInvalidatedError).reapprovers).toEqual(['Mike Okafor']);
    expect(app.store.envelopes(id)).toEqual([]);
  });

  test('tampering with the stored price after approval is also caught', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    // simulate a direct write that bypasses editQuote: a new version with a different price
    const v = app.store.quoteVersion(id)!;
    const priced = priceQuote({ ...v.config, lines: linesWithDiscount(4000) }, RS1, PB1);
    const { serialize } = await import('../src/pricing/codec.ts');
    app.store.insertQuoteVersion({ ...v, version: v.version + 1, materialized: serialize(priced), approvalFingerprint: approvalFingerprint(priced) });
    await expect(app.quotes.send('alice', id)).rejects.toBeInstanceOf(ApprovalInvalidatedError);
  });

  test('a cosmetic edit (cover letter) does not void approvals', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const before = app.store.quoteVersion(id)!.approvalFingerprint;
    app.quotes.editQuote('alice', id, { cover: { title: 'Fixed a typo', intro: 'Thanks!', preparedFor: 'Morgan Ellis' } });
    const q = app.quotes.getQuote(id);
    expect(q.version.version).toBe(2);
    expect(q.version.approvalFingerprint).toBe(before);
    expect(q.quote.state).toBe('APPROVED');
    const env = await app.quotes.send('alice', id);
    expect(env.quoteVersion).toBe(2);
  });

  test('re-approval at the new fingerprint makes the quote sendable again', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    app.quotes.editQuote('alice', id, { lines: linesWithDiscount(1200) });
    expect(app.quotes.getQuote(id).quote.state).toBe('DRAFT');
    const p = app.quotes.submit('alice', id, 'customer asked for 12%');
    expect(p.fingerprintCurrent).toBe(true);
    app.quotes.decide('mike', id, p.stages[0]!.slots[0]!.slotId, 'approved');
    expect((await app.quotes.send('alice', id)).state).toBe('sent');
  });
});

describe('chain resolution', () => {
  test('policy thresholds resolve to a stored, ordered plan', () => {
    // 2,500 seats × 36 months with a 10% rep discount, net 60, custom legal paper
    const c = config({
      termMonths: 36,
      paymentTerms: { netDays: 60, method: 'wire' },
      legalTermsVersion: 'custom-northwind',
      lines: [{ lineId: 'L1', productId: 'plat', quantity: '2500', manualDiscountBp: 1000 }],
    });
    const q = priceQuote(c, RS1, PB1);
    expect(q.floorClamped).toBe(false);
    const plan = resolvePlan(q, c, RS1, 'alice', { users: USERS });
    const shape = plan.stages.map((s) => s.slots.map((x) => `${x.ruleId}:${x.role}`));
    expect(shape).toEqual([
      ['discount-manager:manager'], // sequential, order 10
      ['large-deal-review:deal-desk', 'large-deal-review:finance'], // parallel, order 15
      ['discount-vp:vp-sales'], // order 20
      ['legal-terms:legal'], // order 30 (finance for payment terms / long term already asked once)
      ['mega-deal:cfo'], // order 40
    ]);
    expect(plan.stages[0]!.slots[0]!.eligibleUserIds).toEqual(['mike']);
    expect(plan.summary).toMatch(/total discount on \$1,/);
  });

  test('when a requirement is already covered earlier in the chain it is not asked twice', () => {
    const c = config({ termMonths: 36, lines: [{ lineId: 'L1', productId: 'plat', quantity: '2000', manualDiscountBp: 2500 }] });
    const q = priceQuote(c, RS1, PB1);
    expect(q.floorClamped).toBe(true); // 48% requested vs 45% floor
    const plan = resolvePlan(q, c, RS1, 'alice', { users: USERS });
    const deskSlots = plan.stages.flatMap((s) => s.slots).filter((s) => s.role === 'deal-desk');
    expect(deskSlots.map((s) => s.ruleId)).toEqual(['floor-clamped']);
  });

  test('the quote owner is never an eligible approver of their own quote', () => {
    const app = testApp();
    const id = app.quotes.createQuote('mike', { accountId: 'acct-brightpath', lines: linesWithDiscount(1500) }).quote.id;
    const p = app.quotes.submit('mike', id);
    // manager-of-owner for mike is vera
    expect(p.stages[0]!.slots[0]!.eligibleUserIds).toEqual(['vera']);
    expect(() => app.quotes.decide('mike', id, p.stages[0]!.slots[0]!.slotId, 'approved')).toThrow(/own quote/);
  });

  test('no approval needed → auto-approved', () => {
    const app = testApp();
    const id = app.quotes.createQuote('alice', { accountId: 'acct-brightpath', lines: [{ lineId: 'L1', productId: 'plat', quantity: '5' }] }).quote.id;
    const p = app.quotes.submit('alice', id);
    expect(p.stages).toEqual([]);
    expect(app.quotes.getQuote(id).quote.state).toBe('APPROVED');
  });
});

describe('decisions', () => {
  function bigDeal() {
    const app = testApp();
    const id = app.quotes.createQuote('alice', {
      accountId: 'acct-northwind',
      termMonths: 36,
      lines: [{ lineId: 'L1', productId: 'plat', quantity: '1200', manualDiscountBp: 1500 }],
    }).quote.id;
    const p = app.quotes.submit('alice', id, 'strategic logo');
    return { app, id, p };
  }

  test('sequential stages enforce order; parallel stages accept any order', () => {
    const { app, id, p } = bigDeal();
    const [s0, s1] = p.stages;
    expect(s0!.slots[0]!.eligibleUserIds).toEqual(['mike']);
    expect(s1!.slots).toHaveLength(2);
    // finance can't act before the manager
    expect(() => app.quotes.decide('fran', id, s1!.slots[1]!.slotId, 'approved')).toThrow(/not active yet/);
    app.quotes.decide('mike', id, s0!.slots[0]!.slotId, 'approved');
    // parallel: finance first, then deal desk
    const fin = s1!.slots.find((s) => s.role === 'finance')!;
    const desk = s1!.slots.find((s) => s.role === 'deal-desk')!;
    app.quotes.decide('fran', id, fin.slotId, 'approved');
    let prog = app.quotes.decide('dana', id, desk.slotId, 'conditional', { conditions: 'Term must stay at 36 months' });
    while (prog.activeStage !== null) {
      const st = prog.stages[prog.activeStage]!;
      for (const s of st.slots) prog = app.quotes.decide(s.eligibleUserIds[0]!, id, s.slotId, 'approved');
    }
    expect(app.quotes.getQuote(id).quote.state).toBe('APPROVED');
    const conds = app.store.approvals(id).filter((a) => a.decision === 'conditional');
    expect(conds[0]!.conditions).toBe('Term must stay at 36 months');
  });

  test('ineligible users cannot decide; delegation is recorded', () => {
    const { app, id, p } = bigDeal();
    const slot = p.stages[0]!.slots[0]!;
    expect(() => app.quotes.decide('bob', id, slot.slotId, 'approved')).toThrow(/not an eligible approver/);
    app.quotes.delegate('mike', 'nina', '2026-10-12T00:00:00.000Z', 'vacation');
    app.quotes.decide('nina', id, slot.slotId, 'approved');
    const a = app.store.approvals(id)[0]!;
    expect(a.approverId).toBe('nina');
    expect(a.onBehalfOf).toBe('mike');
    expect(app.quotes.inbox('fran').length).toBe(1);
  });

  test('a rejection needs a reason and sends the quote back', () => {
    const { app, id, p } = bigDeal();
    expect(() => app.quotes.decide('mike', id, p.stages[0]!.slots[0]!.slotId, 'rejected')).toThrow(/reason/);
    app.quotes.decide('mike', id, p.stages[0]!.slots[0]!.slotId, 'rejected', { comment: 'too deep' });
    expect(app.quotes.getQuote(id).quote.state).toBe('REJECTED');
    app.quotes.editQuote('alice', id, { lines: [{ lineId: 'L1', productId: 'plat', quantity: '1200', manualDiscountBp: 500 }] });
    expect(app.quotes.getQuote(id).quote.state).toBe('DRAFT');
  });

  test('recall withdraws a submission', async () => {
    const { app, id } = bigDeal();
    await app.quotes.recall('alice', id);
    expect(app.quotes.getQuote(id).quote.state).toBe('DRAFT');
  });

  test('non-standard deals always route to the top tier and are flagged', () => {
    const app = testApp();
    const id = app.quotes.createQuote('alice', {
      accountId: 'acct-northwind',
      quoteType: 'non-standard',
      nonStandardReason: 'Custom data-residency add-on not in the catalog',
      lines: [{ lineId: 'L1', productId: 'custom-1', quantity: '1', description: 'EU data residency', manualUnitPrice: '15000', chargeType: 'recurring' }],
    }).quote.id;
    const p = app.quotes.submit('alice', id);
    expect(p.stages.map((s) => s.slots[0]!.role)).toEqual(['deal-desk', 'cfo']);
    expect(app.store.quote(id)!.nonStandard).toBe(true);
    expect(app.quotes.nonStandardReport()).toMatchObject({ total: 1, nonStandard: 1, rateBp: 10_000 });
  });
});

describe('business-hours escalation', () => {
  const cal = { utcOffsetMinutes: -420, startHour: 9, endHour: 17, workdays: [1, 2, 3, 4, 5], holidays: [] };
  test('counts only business hours', () => {
    // Fri 2026-10-09 16:00 PDT → Mon 10:00 PDT = 1h Friday + 1h Monday
    expect(businessMinutesBetween('2026-10-09T23:00:00Z', '2026-10-12T17:00:00Z', cal)).toBe(120);
    // Friday 5pm submission does not escalate over the weekend
    expect(escalationDue('2026-10-10T00:00:00Z', '2026-10-12T15:59:00Z', 8, cal)).toBe(false);
    expect(escalationDue('2026-10-10T00:00:00Z', '2026-10-13T00:00:00Z', 8, cal)).toBe(true);
  });

  test('stalled slots escalate to the approver’s manager', () => {
    const app = testApp('2026-10-09T23:30:00.000Z'); // Friday 16:30 PDT
    const id = app.quotes.createQuote('alice', managerApprovalInput()).quote.id;
    app.quotes.submit('alice', id);
    app.clock.set('2026-10-12T20:00:00.000Z'); // Monday 13:00 PDT: 0.5 + 4 = 4.5h
    expect(app.quotes.runEscalations()).toEqual([]);
    app.clock.set('2026-10-13T16:00:00.000Z'); // Tuesday 09:00 PDT: 8.5h
    const esc = app.quotes.runEscalations();
    expect(esc).toEqual([{ quoteId: id, slotId: 's1', addedUserIds: ['vera'] }]);
    expect(app.quotes.runEscalations()).toEqual([]); // once
    app.quotes.decide('vera', id, 's1', 'approved');
    expect(app.quotes.getQuote(id).quote.state).toBe('APPROVED');
  });
});

describe('state machine', () => {
  test('terminal states are terminal', () => {
    for (const s of TERMINAL) {
      for (const t of ['edited', 'submitted', 'sent', 'signed', 'recalled'] as const) {
        expect(() => nextState(s, { type: t, payload: {} })).toThrow(InvalidTransitionError);
      }
    }
  });
  test('editing from pre-send states returns to DRAFT unless immaterial on an APPROVED quote', () => {
    expect(nextState('PENDING_APPROVAL', { type: 'edited', payload: { material: true } })).toBe('DRAFT');
    expect(nextState('APPROVED', { type: 'edited', payload: { material: true } })).toBe('DRAFT');
    expect(nextState('APPROVED', { type: 'edited', payload: { material: false } })).toBe('APPROVED');
    expect(() => nextState('SENT', { type: 'edited', payload: {} })).toThrow();
  });
  test('fold reconstructs state from events', () => {
    expect(fold([{ type: 'created', payload: {} }, { type: 'submitted', payload: {} }, { type: 'approved', payload: {} }, { type: 'sent', payload: {} }, { type: 'viewed', payload: {} }, { type: 'signed', payload: {} }, { type: 'closed-won', payload: {} }])).toBe('CLOSED_WON');
  });
});
