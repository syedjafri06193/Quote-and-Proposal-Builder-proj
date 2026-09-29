/**
 * Populate data/db.json with a handful of quotes in different states, so the
 * UI has something to show on first run.
 *
 *   npm run seed   (then npm start)
 */
import { existsSync, rmSync } from 'node:fs';
import { createApp } from '../src/app/app.ts';

const file = process.env.DATA_FILE ?? 'data/db.json';
if (existsSync(file)) {
  if (!process.argv.includes('--force')) {
    console.log(`${file} already exists; run with --force to replace it.`);
    process.exit(0);
  }
  rmSync(file);
}
const app = createApp({ dataFile: file });
const q = app.quotes;
const approveAll = (id: string) => {
  let p = q.progress(id);
  while (p.activeStage !== null) for (const s of p.stages[p.activeStage]!.slots) p = q.decide(s.eligibleUserIds[0]!, id, s.slotId, 'approved');
};

// 1. Closed-won deal with a full audit trail
const won = q.createQuote('alice', {
  accountId: 'acct-brightpath',
  channel: 'partner-silver',
  termMonths: 24,
  lines: [
    { lineId: 'L1', productId: 'plat', quantity: '120', manualDiscountBp: 1500 },
    { lineId: 'L2', productId: 'sso', quantity: '1' },
    { lineId: 'L3', productId: 'onb', quantity: '1' },
  ],
  cover: { title: 'Brightpath platform proposal', intro: 'Thank you for considering Lumen Cloud for Brightpath Health.', preparedFor: 'Morgan Ellis' },
}).quote.id;
q.submit('alice', won, 'Competitive against incumbent; 15% matches their renewal offer.');
approveAll(won);
const env = await q.send('alice', won);
await (app.provider as import('../src/esign/fake.ts').FakeESignProvider).sign(env.providerId!);

// 2. Big enterprise deal waiting on a multi-stage approval chain
const big = q.createQuote('bob', {
  accountId: 'acct-northwind',
  channel: 'partner-gold',
  promoCodes: ['Q4-2026'],
  termMonths: 36,
  paymentTerms: { netDays: 45, method: 'wire' },
  lines: [
    { lineId: 'L1', productId: 'plat', quantity: '1200', manualDiscountBp: 1200 },
    { lineId: 'L2', productId: 'api', quantity: '12000000' },
    { lineId: 'L3', productId: 'prem', quantity: '1' },
    { lineId: 'L4', productId: 'train', quantity: '6' },
  ],
  cover: { title: 'Northwind enterprise agreement', intro: 'A three-year agreement covering the platform, API commit and premium support.', preparedFor: 'Jordan Blake' },
}).quote.id;
const p = q.submit('bob', big, 'Strategic logo; CFO call on Friday.');
q.decide('mike', big, p.stages[0]!.slots[0]!.slotId, 'approved');

// 3. A draft with a floor clamp warning
q.createQuote('alice', {
  accountId: 'acct-riverbend',
  termMonths: 12,
  lines: [
    { lineId: 'L1', productId: 'plat', quantity: '25' },
    { lineId: 'L2', productId: 'onb', quantity: '1', manualDiscountBp: 7000 },
  ],
  cover: { title: 'Riverbend proposal', intro: '', preparedFor: 'Casey Nguyen' },
});

// 4. A sanctioned non-standard deal
q.createQuote('alice', {
  accountId: 'acct-northwind',
  quoteType: 'non-standard',
  nonStandardReason: 'EU data-residency add-on is not in the catalog yet',
  lines: [{ lineId: 'L1', productId: 'custom-1', quantity: '1', description: 'EU data residency (Frankfurt region)', manualUnitPrice: '18000', chargeType: 'recurring' }],
  cover: { title: 'Northwind data residency', intro: '', preparedFor: 'Jordan Blake' },
});

console.log(`Seeded ${app.store.quotes().length} quotes into ${file}. Start the app with: npm start`);
