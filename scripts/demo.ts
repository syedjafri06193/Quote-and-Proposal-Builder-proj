/**
 * End-to-end walkthrough on an in-memory store with a manual clock:
 *   quote → approvals (incl. the edit-after-approval refusal) → proposal PDF
 *   → e-signature with a dropped webhook → reconciliation → executed contract.
 *
 *   npm run demo
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createApp } from '../src/app/app.ts';
import { ManualClock, ApprovalInvalidatedError } from '../src/app/errors.ts';
import { FakeESignProvider } from '../src/esign/fake.ts';

const clock = new ManualClock('2026-10-05T16:00:00.000Z'); // Mon 09:00 PDT
const app = createApp({ clock, log: (m, d) => console.log(`  [log] ${m}`, d ?? '') });
const fake = app.provider as FakeESignProvider;
const { quotes } = app;
const h = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}`);

h('1. Alice builds a quote for Northwind');
let view = quotes.createQuote('alice', {
  accountId: 'acct-northwind',
  channel: 'partner-gold',
  promoCodes: ['Q4-2026'],
  asOf: '2026-10-05',
  startDate: '2026-11-01',
  termMonths: 36,
  lines: [
    { lineId: 'L1', productId: 'plat', quantity: '250', manualDiscountBp: 800 },
    { lineId: 'L2', productId: 'api', quantity: '2500000' },
    { lineId: 'L3', productId: 'prem', quantity: '1' },
    { lineId: 'L4', productId: 'onb', quantity: '1' },
  ],
  cover: { title: 'Northwind platform proposal', intro: 'Thank you for the opportunity. This proposal covers a three-year platform subscription.', preparedFor: 'Jordan Blake' },
});
const id = view.quote.id;
console.log(quotes.traceText(id));

h('2. Submit — approval chain resolved and stored');
let prog = quotes.submit('alice', id, 'Competitive displacement; customer needs Q4 signature.');
for (const st of prog.stages) console.log(`  stage ${st.index} [${st.status}]`, st.slots.map((s) => `${s.slotId}:${s.label}→${s.eligibleUserIds.join('|')}`).join(', '));
console.log('  summary:', prog.plan?.plan.summary);

h('3. Approvers decide (parallel stage in one go)');
for (const st of prog.stages) {
  for (const s of st.slots) {
    const who = s.eligibleUserIds[0]!;
    prog = quotes.decide(who, id, s.slotId, 'approved');
    console.log(`  ${who} approved ${s.label}`);
  }
}
console.log('  state:', quotes.getQuote(id).quote.state);

h('4. Abuse test: edit the discount after approval, then try to send');
quotes.editQuote('alice', id, { lines: view.priced.lines.map((l, i) => ({ lineId: l.lineId, productId: l.productId, quantity: l.quantity.toString(), ...(i === 0 ? { manualDiscountBp: 2500 } : {}) })) });
try {
  await quotes.send('alice', id);
} catch (e) {
  console.log(`  refused: ${(e as Error).message}`, e instanceof ApprovalInvalidatedError ? '✓' : '');
}

h('5. Put the discount back (cosmetic cover edit too) and resubmit — prior approvals carry over');
quotes.editQuote('alice', id, { lines: view.priced.lines.map((l, i) => ({ lineId: l.lineId, productId: l.productId, quantity: l.quantity.toString(), ...(i === 0 ? { manualDiscountBp: 800 } : {}) })), cover: { title: 'Northwind platform proposal (rev)', intro: 'Thank you for the opportunity.', preparedFor: 'Jordan Blake' } });
prog = quotes.submit('alice', id, 'Reverted discount.');
console.log('  state:', quotes.getQuote(id).quote.state);

h('6. Send — webhooks are down during this deploy');
fake.dropWebhooks = true;
const env = await quotes.send('alice', id);
const again = await quotes.send('alice', id);
console.log(`  envelope ${env.id} (${env.providerId}); retry returned the same envelope: ${again.id === env.id}`);
await fake.view(env.providerId!);
await fake.sign(env.providerId!);
console.log('  provider says completed; our state:', quotes.getQuote(id).quote.state);

h('7. Reconciliation poll catches the drift');
clock.advanceMinutes(15);
const rec = await quotes.reconcile();
console.log('  reconcile:', JSON.stringify(rec.drifted));
view = quotes.getQuote(id);
console.log('  state:', view.quote.state);

h('8. Executed contract for billing');
const c = quotes.contract(id);
console.log(JSON.stringify({ ...c, lines: c.lines.slice(0, 2) }, null, 2).split('\n').slice(0, 40).join('\n'), '\n  …');
console.log('  outbox:', app.store.outbox().map((o) => `${o.topic} ${o.idempotencyKey}`));

h('9. Integrity checks');
console.log('  replay:', quotes.replayAll().every((r) => r.ok) ? 'all versions reproduce ✓' : quotes.replayAll());
console.log('  state/event-log consistency:', quotes.consistencyCheck().length === 0 ? 'consistent ✓' : 'MISMATCH');

mkdirSync('data', { recursive: true });
const { bytes } = await quotes.generateDocument(id, view.version.version);
writeFileSync('data/demo-proposal.pdf', bytes);
console.log('\nWrote data/demo-proposal.pdf');
