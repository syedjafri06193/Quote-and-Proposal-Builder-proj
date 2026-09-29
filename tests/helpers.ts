import { createApp, type App, type AppDeps } from '../src/app/app.ts';
import type { Engine } from '../src/app/quotes.ts';
import { ManualClock } from '../src/app/errors.ts';
import { FakeESignProvider } from '../src/esign/fake.ts';
import { PRICE_BOOK_V1, RULE_SET_V1 } from '../src/seed/data.ts';
import type { QuoteConfig, RuleSet } from '../src/pricing/types.ts';

export const RS1: RuleSet = { ...structuredClone(RULE_SET_V1), version: 1, effectiveFrom: '2026-01-01T00:00:00.000Z' };
export const PB1 = PRICE_BOOK_V1;

export function config(over: Partial<QuoteConfig> = {}): QuoteConfig {
  return {
    quoteType: 'standard',
    currency: 'USD',
    accountId: 'acct-northwind',
    segment: 'enterprise',
    channel: 'direct',
    promoCodes: [],
    asOf: '2026-10-05',
    startDate: '2026-11-01',
    termMonths: 12,
    paymentTerms: { netDays: 30, method: 'ACH' },
    legalTermsVersion: 'std-2026.1',
    autoRenew: true,
    noticePeriodDays: 30,
    lines: [{ lineId: 'L1', productId: 'plat', quantity: '10' }],
    cover: { title: 'Proposal', intro: '', preparedFor: 'Jordan Blake' },
    ...over,
  };
}

/** Monday 2026-10-05 09:00 PDT. */
export const MONDAY_9AM = '2026-10-05T16:00:00.000Z';

export type TestApp = App & { clock: ManualClock; fake: FakeESignProvider; logs: string[] };

export function testApp(start = MONDAY_9AM, engine?: Engine): TestApp {
  const clock = new ManualClock(start);
  const logs: string[] = [];
  const deps: AppDeps = { clock, log: (m) => logs.push(m) };
  if (engine) deps.engine = engine;
  const app = createApp(deps);
  return { ...app, clock, fake: app.provider as FakeESignProvider, logs };
}

/** A quote that needs one manager approval (15% rep discount). */
export function managerApprovalInput(): Partial<QuoteConfig> & Pick<QuoteConfig, 'accountId' | 'lines'> {
  return {
    accountId: 'acct-brightpath',
    asOf: '2026-10-05',
    startDate: '2026-11-01',
    termMonths: 12,
    lines: [
      { lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: 1500 },
      { lineId: 'L2', productId: 'onb', quantity: '1' },
    ],
  };
}

/** Create → submit → approve all → APPROVED. Returns the quote id. */
export function approvedQuote(app: App, input = managerApprovalInput()): string {
  const v = app.quotes.createQuote('alice', input);
  const id = v.quote.id;
  let p = app.quotes.submit('alice', id, 'test');
  while (p.activeStage !== null) {
    const stage = p.stages[p.activeStage]!;
    for (const s of stage.slots) p = app.quotes.decide(s.eligibleUserIds[0]!, id, s.slotId, 'approved');
  }
  return id;
}
