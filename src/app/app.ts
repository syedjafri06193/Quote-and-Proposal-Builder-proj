/**
 * Composition root: store + clock + e-sign provider + services, seeded on
 * first run.
 */
import { Store } from '../store/store.ts';
import { QuoteService, type Engine } from './quotes.ts';
import { systemClock, type Clock } from './errors.ts';
import { FakeESignProvider } from '../esign/fake.ts';
import type { ESignProvider } from '../esign/provider.ts';
import { ACCOUNTS, PRICE_BOOK_V1, RULE_SET_V1, USERS } from '../seed/data.ts';
import { ruleSetContentHash } from './rules.ts';
import { priceQuote } from '../pricing/pipeline.ts';

export const TEMPLATE_V1 = {
  version: 1,
  name: 'Standard proposal',
  publishedAt: '2026-01-01T00:00:00.000Z',
  body: {
    companyName: 'Lumen Cloud, Inc.',
    companyAddress: '500 Capitol Mall, Suite 1200, Sacramento, CA 95814',
    termsSummary: [
      'Subscription fees are invoiced annually in advance; one-time fees on the start date.',
      'This proposal is governed by the Master Subscription Agreement referenced above.',
      'Prices exclude applicable taxes, which are calculated at invoicing.',
      'This proposal is valid for 30 days from the pricing date.',
    ],
    slaAppendix: [
      'Monthly uptime commitment of 99.9%, excluding scheduled maintenance announced 72 hours in advance.',
      'Service credits of 10% of the monthly fee for each 0.1% below the commitment, capped at 50%.',
      'P1 incidents: 1-hour response, continuous effort until resolved.',
    ],
    footerNote: 'Lumen Cloud — Confidential',
  },
};

export type AppDeps = {
  dataFile?: string | null;
  clock?: Clock;
  provider?: ESignProvider;
  engine?: Engine;
  webhookSecret?: string;
  log?: (msg: string, data?: unknown) => void;
};

export type App = {
  store: Store;
  clock: Clock;
  provider: ESignProvider;
  quotes: QuoteService;
};

export function seed(store: Store): void {
  if (!store.isEmpty) return;
  store.putUsers(USERS);
  store.putAccounts(ACCOUNTS);
  store.insertPriceBook(PRICE_BOOK_V1);
  store.insertRuleSet({
    version: 1,
    definition: RULE_SET_V1,
    contentHash: ruleSetContentHash(RULE_SET_V1, '2026-01-01T00:00:00.000Z'),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
    publishedBy: 'sam',
    approvedBy: 'priya',
    draftId: null,
    notes: 'Initial rule set',
  });
  store.insertTemplate(TEMPLATE_V1);
}

export function createApp(deps: AppDeps = {}): App {
  const clock = deps.clock ?? systemClock;
  const store = new Store(deps.dataFile ?? null);
  seed(store);
  const provider = deps.provider ?? new FakeESignProvider(deps.webhookSecret ?? 'dev-webhook-secret', () => clock.now());
  const quotes = new QuoteService(store, clock, provider, deps.engine ?? priceQuote, undefined, deps.log);
  // Wire the fake provider's webhooks straight into our handler (in production this is an HTTP POST).
  if (provider instanceof FakeESignProvider) {
    provider.setSink(async (d) => {
      try {
        await quotes.handleWebhook(d.headers, d.body);
      } catch (e) {
        deps.log?.('webhook handling failed', (e as Error).message);
      }
    });
  }
  return { store, clock, provider, quotes };
}
