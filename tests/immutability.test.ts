/**
 * Immutability (design guide §4): reads never reprice, repricing creates a
 * new version, published rule sets never change, and every historical quote
 * replays byte-for-byte (§4.3, §13.4).
 */
import { describe, expect, test } from 'vitest';
import { priceQuote } from '../src/pricing/pipeline.ts';
import { toDecimalString } from '../src/money/money.ts';
import { DuplicateKeyError } from '../src/store/store.ts';
import { fold } from '../src/approvals/stateMachine.ts';
import { testApp, managerApprovalInput, approvedQuote } from './helpers.ts';
import type { Engine } from '../src/app/quotes.ts';

describe('quote immutability', () => {
  test('getQuote never calls the pricing engine', () => {
    let armed = false;
    let calls = 0;
    const engine: Engine = (c, rs, pb) => {
      calls++;
      if (armed) throw new Error('the pricing engine was called on a read path');
      return priceQuote(c, rs, pb);
    };
    const app = testApp(undefined, engine);
    const id = app.quotes.createQuote('alice', managerApprovalInput()).quote.id;
    const before = calls;
    armed = true;
    for (let i = 0; i < 5; i++) {
      const v = app.quotes.getQuote(id);
      expect(toDecimalString(v.priced.total)).toBe(toDecimalString(app.quotes.getQuote(id, 1).priced.total));
    }
    app.quotes.listQuotes();
    app.quotes.traceText(id);
    app.quotes.progress(id);
    app.quotes.auditExport(id);
    expect(calls).toBe(before);
  });

  test('repricing after a rule change creates a new version; the old one is untouched', async () => {
    const app = testApp();
    const id = app.quotes.createQuote('alice', { accountId: 'acct-northwind', channel: 'partner-gold', lines: [{ lineId: 'L1', productId: 'plat', quantity: '10' }] }).quote.id;
    const v1 = app.quotes.getQuote(id);
    expect(toDecimalString(v1.priced.total)).toBe('2160.00'); // 2400 − 10%

    // governance: raise the gold partner discount to 20% and publish as v2
    const d = app.quotes.rules.createDraft('sam', { title: 'Gold to 20%' });
    const def = structuredClone(d.definition);
    def.discountRules.find((r) => r.id === 'partner-gold')!.effect = { type: 'percent', basisPoints: 2000 };
    app.quotes.rules.updateDraft('sam', d.id, { definition: def });
    app.quotes.rules.simulateDraft('sam', d.id);
    app.quotes.rules.submitDraft('sam', d.id);
    app.clock.advanceMinutes(1);
    app.quotes.rules.approveDraft('priya', d.id);

    // reading the quote still shows the numbers the customer saw
    const reread = app.quotes.getQuote(id);
    expect(reread.version.version).toBe(1);
    expect(toDecimalString(reread.priced.total)).toBe('2160.00');
    expect(reread.priced.ruleSetVersion).toBe(1);

    // repricing is explicit and creates v2 under rule set v2
    const r = app.quotes.reprice('alice', id);
    expect(r.version.version).toBe(2);
    expect(r.priced.ruleSetVersion).toBe(2);
    expect(toDecimalString(r.priced.total)).toBe('1920.00');
    expect(toDecimalString(app.quotes.getQuote(id, 1).priced.total)).toBe('2160.00');
    expect(app.store.quoteVersions(id).map((v) => v.version)).toEqual([1, 2]);
  });

  test('versions and rule sets are insert-only', () => {
    const app = testApp();
    const id = app.quotes.createQuote('alice', managerApprovalInput()).quote.id;
    const v1 = app.store.quoteVersion(id, 1)!;
    expect(() => app.store.insertQuoteVersion({ ...v1, materialized: '{}' })).toThrow(DuplicateKeyError);
    const rs = app.store.ruleSet(1)!;
    expect(() => app.store.insertRuleSet({ ...rs, definition: { ...rs.definition, currency: 'EUR' } })).toThrow(DuplicateKeyError);
    // returned objects are copies: mutating them doesn't touch the store
    v1.materialized = 'tampered';
    expect(app.store.quoteVersion(id, 1)!.materialized).not.toBe('tampered');
  });
});

describe('replay regression', () => {
  test('every historical quote version reproduces under its pinned rule set and price book', async () => {
    const app = testApp();
    // build a varied history across two rule-set versions
    const a = approvedQuote(app);
    app.quotes.createQuote('bob', { accountId: 'acct-riverbend', termMonths: 36, lines: [{ lineId: 'L1', productId: 'plat', quantity: '40' }, { lineId: 'L2', productId: 'train', quantity: '5' }] });
    app.quotes.createQuote('alice', { accountId: 'acct-northwind', termMonths: 36, promoCodes: ['LAUNCH'], lines: [{ lineId: 'L1', productId: 'plat', quantity: '1000' }, { lineId: 'L2', productId: 'api', quantity: '12000000' }] });
    await app.quotes.send('alice', a);
    const d = app.quotes.rules.createDraft('sam', { title: 'Tighter floors' });
    const def = structuredClone(d.definition);
    def.floors.defaultMaxDiscountBp = 2500;
    def.rounding.mode = 'half-even';
    app.quotes.rules.updateDraft('sam', d.id, { definition: def });
    app.quotes.rules.simulateDraft('sam', d.id);
    app.quotes.rules.submitDraft('sam', d.id);
    app.quotes.rules.approveDraft('priya', d.id);
    for (const q of app.store.quotes()) if (q.state === 'DRAFT') app.quotes.reprice(q.ownerId, q.id);

    const results = app.quotes.replayAll();
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(new Set(app.store.quoteVersions().map((v) => v.ruleSetVersion))).toEqual(new Set([1, 2]));
  });

  test('the stored state column always equals the fold of the event log', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    await app.quotes.send('alice', id);
    expect(app.quotes.consistencyCheck()).toEqual([]);
    expect(fold(app.store.events(id))).toBe('SENT');
  });
});
