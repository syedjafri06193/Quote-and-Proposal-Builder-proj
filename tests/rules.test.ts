/**
 * Rule governance (design guide §12): rules are data, changes are simulated
 * and approved by a named owner, published rule sets are immutable and never
 * retroactive.
 */
import { describe, expect, test } from 'vitest';
import { testApp, approvedQuote } from './helpers.ts';
import { diff } from '../src/rules/diff.ts';

function withHistory() {
  const app = testApp();
  approvedQuote(app);
  app.quotes.createQuote('bob', { accountId: 'acct-northwind', channel: 'partner-gold', termMonths: 36, lines: [{ lineId: 'L1', productId: 'plat', quantity: '300' }, { lineId: 'L2', productId: 'prem', quantity: '1' }] });
  app.quotes.createQuote('alice', { accountId: 'acct-brightpath', lines: [{ lineId: 'L1', productId: 'plat', quantity: '80', manualDiscountBp: 900 }] });
  return app;
}

describe('rule governance', () => {
  test('full lifecycle: draft → simulate → submit → approve publishes an immutable new version', () => {
    const app = withHistory();
    const d = app.quotes.rules.createDraft('sam', { title: 'Rep authority to 5%' });
    const def = structuredClone(d.definition);
    const mgr = def.approvalRules.find((r) => r.id === 'discount-manager')!;
    mgr.condition = { op: 'or', terms: [{ op: 'gt', field: 'approval.maxManualDiscountBp', value: 500 }, { op: 'gt', field: 'approval.totalDiscountBp', value: 2000 }] };
    app.quotes.rules.updateDraft('sam', d.id, { definition: def });

    expect(() => app.quotes.rules.submitDraft('sam', d.id)).toThrow(/simulation is mandatory/);
    const sim = app.quotes.rules.simulateDraft('sam', d.id);
    expect(sim.sampleSize).toBe(3);
    expect(sim.totalDelta).toBe('$0.00'); // an approval-threshold change doesn't move prices…
    expect(sim.newlyRequiresApproval).toBe(1); // …but it does move approval load (the 9% quote)
    expect(sim.headline).toContain('1 would newly need more approval');

    app.quotes.rules.submitDraft('sam', d.id, 'tighten rep authority');
    expect(() => app.quotes.rules.approveDraft('sam', d.id)).toThrow(/is not a pricing owner/);
    const rec = app.quotes.rules.approveDraft('priya', d.id);
    expect(rec.version).toBe(2);
    expect(rec.approvedBy).toBe('priya');
    expect(app.quotes.rules.current().version).toBe(2);
    expect(app.quotes.rules.byVersion(1).approvalRules.find((r) => r.id === 'discount-manager')!.condition).not.toEqual(mgr.condition);
    expect(() => app.quotes.rules.updateDraft('sam', d.id, { title: 'x' })).toThrow(/PUBLISHED/);
  });

  test('simulation measures revenue impact', () => {
    const app = withHistory();
    const d = app.quotes.rules.createDraft('sam', { title: 'Gold partner 10% → 15%' });
    const def = structuredClone(d.definition);
    def.discountRules.find((r) => r.id === 'partner-gold')!.effect = { type: 'percent', basisPoints: 1500 };
    app.quotes.rules.updateDraft('sam', d.id, { definition: def });
    const sim = app.quotes.rules.simulateDraft('sam', d.id);
    expect(sim.decreased).toBe(1);
    expect(sim.unchanged).toBe(2);
    expect(BigInt(sim.totalDeltaMinor) < 0n).toBe(true);
    expect(sim.headline).toMatch(/reduced revenue on the last 3 quote\(s\) by \$/);
  });

  test('an edit after simulation forces re-simulation', () => {
    const app = withHistory();
    const d = app.quotes.rules.createDraft('sam', { title: 't' });
    app.quotes.rules.simulateDraft('sam', d.id);
    app.quotes.rules.updateDraft('sam', d.id, { title: 'renamed' });
    expect(() => app.quotes.rules.submitDraft('sam', d.id)).toThrow(/simulation is mandatory/);
  });

  test('the author cannot approve their own change, and invalid rules cannot be simulated', () => {
    const app = withHistory();
    const d = app.quotes.rules.createDraft('priya', { title: 'owner-authored' });
    app.quotes.rules.simulateDraft('priya', d.id);
    app.quotes.rules.submitDraft('priya', d.id);
    expect(() => app.quotes.rules.approveDraft('priya', d.id)).toThrow(/author/);

    const bad = app.quotes.rules.createDraft('sam', { title: 'typo' });
    const def = structuredClone(bad.definition);
    def.discountRules[0]!.condition = { op: 'eq', field: 'quote.segmnt', value: 'x' };
    def.discountRules[1]!.effect = { type: 'percent', basisPoints: 12000 };
    app.quotes.rules.updateDraft('sam', bad.id, { definition: def });
    expect(() => app.quotes.rules.simulateDraft('sam', bad.id)).toThrow(/does not validate/);
    const v = app.quotes.rules.getDraft(bad.id).validation.errors;
    expect(v.some((e) => e.includes('unknown field "quote.segmnt"'))).toBe(true);
    expect(v.some((e) => e.includes('basisPoints must be 0–10000'))).toBe(true);
  });

  test('reps cannot author rules', () => {
    const app = testApp();
    expect(() => app.quotes.rules.createDraft('alice', { title: 'free stuff' })).toThrow(/cannot author/);
  });

  test('effective dating: future changes take effect later, retroactive ones are refused', () => {
    const app = withHistory();
    const d = app.quotes.rules.createDraft('sam', { title: 'Q1 price list', effectiveFrom: '2027-01-01T08:00:00.000Z' });
    app.quotes.rules.simulateDraft('sam', d.id);
    app.quotes.rules.submitDraft('sam', d.id);
    app.quotes.rules.approveDraft('priya', d.id);
    expect(app.quotes.rules.current().version).toBe(1);
    expect(app.quotes.rules.current('2027-01-02T00:00:00.000Z').version).toBe(2);

    const r = app.quotes.rules.createDraft('sam', { title: 'backdated', effectiveFrom: '2026-01-01T00:00:00.000Z' });
    app.quotes.rules.simulateDraft('sam', r.id);
    app.quotes.rules.submitDraft('sam', r.id);
    expect(() => app.quotes.rules.approveDraft('priya', r.id)).toThrow(/retroactive/);
  });

  test('diff matches rules by id, not position', () => {
    const a = { rules: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] };
    const b = { rules: [{ id: 'b', v: 3 }, { id: 'c', v: 1 }] };
    expect(diff(a, b)).toEqual([
      { path: 'rules[a]', kind: 'removed', before: { id: 'a', v: 1 } },
      { path: 'rules[b].v', kind: 'changed', before: 2, after: 3 },
      { path: 'rules[c]', kind: 'added', after: { id: 'c', v: 1 } },
    ]);
  });

  test('an in-flight approval follows the plan it started with', () => {
    const app = withHistory();
    const id = app.quotes.createQuote('alice', { accountId: 'acct-brightpath', lines: [{ lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: 1500 }] }).quote.id;
    const p = app.quotes.submit('alice', id);
    expect(p.stages).toHaveLength(1);
    // raise rep authority to 20% mid-flight
    const d = app.quotes.rules.createDraft('sam', { title: 'more authority' });
    const def = structuredClone(d.definition);
    def.approvalRules = def.approvalRules.filter((r) => r.id !== 'discount-manager');
    app.quotes.rules.updateDraft('sam', d.id, { definition: def });
    app.quotes.rules.simulateDraft('sam', d.id);
    app.quotes.rules.submitDraft('sam', d.id);
    app.quotes.rules.approveDraft('priya', d.id);
    expect(app.quotes.progress(id).stages).toHaveLength(1);
    app.quotes.decide('mike', id, p.stages[0]!.slots[0]!.slotId, 'approved');
    expect(app.quotes.getQuote(id).quote.state).toBe('APPROVED');
  });
});
