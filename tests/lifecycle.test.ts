/**
 * Document generation (§9), e-signature (§10) and the downstream contract (§11).
 */
import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractContentHash, generateProposalPdf, buildRenderModel, pdfSafe } from '../src/documents/generate.ts';
import { validateExecutedContract, termEnd, addMonths } from '../src/contracts/contract.ts';
import { hmacSha256Hex, sha256 } from '../src/util/hash.ts';
import { WebhookVerificationError } from '../src/esign/provider.ts';
import { priceQuote } from '../src/pricing/pipeline.ts';
import { ACCOUNTS } from '../src/seed/data.ts';
import { TEMPLATE_V1 } from '../src/app/app.ts';
import { testApp, approvedQuote, config, RS1, PB1 } from './helpers.ts';

describe('deterministic documents', () => {
  const model = (segment = 'mid-market') =>
    buildRenderModel({
      priced: priceQuote(config({ segment, lines: Array.from({ length: 40 }, (_, i) => ({ lineId: `L${i + 1}`, productId: i % 2 ? 'train' : 'plat', quantity: String(i + 1) })) }), RS1, PB1),
      config: config({ segment }),
      account: ACCOUNTS[0]!,
      template: TEMPLATE_V1,
      quoteNumber: 1001,
      quoteVersion: 3,
      pricedAt: '2026-10-05T16:00:00.000Z',
      approvalConditions: ['Term must stay at 36 months'],
    });

  test('generating the same quote twice is byte-identical', async () => {
    const a = await generateProposalPdf(model());
    const b = await generateProposalPdf(model());
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.pageCount).toBeGreaterThan(1); // 40 lines span pages with repeated headers
  });

  test('metadata is fixed to the quote time and carries the content reference', async () => {
    const g = await generateProposalPdf(model());
    const doc = await PDFDocument.load(g.bytes, { updateMetadata: false });
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-10-05T16:00:00.000Z');
    expect(doc.getModificationDate()?.toISOString()).toBe('2026-10-05T16:00:00.000Z');
    expect(await extractContentHash(g.bytes)).toBe(g.contentHash);
  });

  test('conditional SLA appendix and non-WinAnsi text', async () => {
    expect(model('enterprise').showSla).toBe(true);
    expect(model('mid-market').showSla).toBe(false);
    expect(pdfSafe('≥ 10 − 2 → ✓ 日本')).toBe('>= 10 - 2 -> v ??');
  });

  test('templates are versioned: a version re-renders with the template it was first rendered with', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const first = await app.quotes.generateDocument(id);
    app.store.insertTemplate({ ...TEMPLATE_V1, version: 2, body: { ...TEMPLATE_V1.body, footerNote: 'New footer' } });
    const again = await app.quotes.generateDocument(id);
    expect(again.record.templateVersion).toBe(1);
    expect(again.record.sha256).toBe(first.record.sha256);
  });
});

describe('e-signature', () => {
  test('happy path: send → view → sign → verified → CLOSED_WON + contract event', async () => {
    const app = testApp();
    const events: unknown[] = [];
    app.quotes.subscribe((topic, payload) => events.push({ topic, payload }));
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    expect(app.quotes.getQuote(id).quote.state).toBe('SENT');
    await app.fake.view(env.providerId!);
    expect(app.quotes.getQuote(id).quote.state).toBe('VIEWED');
    await app.fake.sign(env.providerId!);
    expect(app.quotes.getQuote(id).quote.state).toBe('CLOSED_WON');
    const k = app.store.contract(id)!;
    expect(app.store.blob(k.certificateKey)).toBeDefined(); // completion certificate stored
    expect(events).toHaveLength(1);
    expect(app.store.outbox('contract.executed')).toHaveLength(1);
    expect(app.quotes.consistencyCheck()).toEqual([]);
  });

  test('retrying send never creates a second envelope', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const [a, b] = await Promise.all([app.quotes.send('alice', id), app.quotes.send('alice', id)]);
    const c = await app.quotes.send('alice', id);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(app.fake.list()).toHaveLength(1);
    expect(a.idempotencyKey).toBe(sha256(`${id}:1:${app.store.documents(id)[0]!.sha256}`));
  });

  test('a crash between the provider call and the response is recovered, not re-sent', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    app.fake.failAfterNextCreate = true;
    await expect(app.quotes.send('alice', id)).rejects.toThrow(/simulated network failure/);
    expect(app.store.envelopes(id)[0]!.state).toBe('creating'); // key stored before the call
    const env = await app.quotes.send('alice', id);
    expect(env.state).toBe('sent');
    expect(app.fake.list()).toHaveLength(1);
  });

  test('a dropped webhook still converges via reconciliation, and the drift is logged', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    app.fake.dropWebhooks = true;
    await app.fake.sign(env.providerId!);
    expect(app.quotes.getQuote(id).quote.state).toBe('SENT');
    app.clock.advanceMinutes(5);
    expect((await app.quotes.reconcile(10)).checked).toBe(0); // too recent
    app.clock.advanceMinutes(10);
    const r = await app.quotes.reconcile(10);
    expect(r.drifted).toEqual([{ envelopeId: env.id, local: 'sent', remote: 'completed' }]);
    expect(app.quotes.getQuote(id).quote.state).toBe('CLOSED_WON');
    expect(app.logs.some((l) => l.includes('drift'))).toBe(true);
    // the late webhook arrives after all: idempotent no-op
    await app.fake.redeliverDropped();
    expect(app.store.outbox()).toHaveLength(1);
    expect(app.quotes.consistencyCheck()).toEqual([]);
  });

  test.each([
    ['decline', 'DECLINED'],
    ['expire', 'EXPIRED'],
  ] as const)('%s drives the quote to %s', async (action, state) => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    if (action === 'decline') await app.fake.decline(env.providerId!, 'budget cut');
    else await app.fake.expire(env.providerId!);
    expect(app.quotes.getQuote(id).quote.state).toBe(state);
    if (action === 'decline') expect(app.store.envelopes(id)[0]!.declineReason).toBe('budget cut');
    // terminal: clone to continue
    const c = app.quotes.cloneQuote('alice', id);
    expect(c.quote.state).toBe('DRAFT');
  });

  test('voided by the provider → VOIDED; recall voids proactively and returns to DRAFT', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    await app.fake.void(env.providerId!, 'ops');
    expect(app.quotes.getQuote(id).quote.state).toBe('VOIDED');

    const id2 = approvedQuote(app);
    const env2 = await app.quotes.send('alice', id2);
    await app.quotes.recall('alice', id2, 'superseding');
    expect(app.quotes.getQuote(id2).quote.state).toBe('DRAFT');
    expect((await app.fake.getEnvelope(env2.providerId!)).state).toBe('voided');
    await expect(app.fake.sign(env2.providerId!)).rejects.toThrow(); // the customer can't sign the stale version
  });

  test('a signed document that does not match the generated one is flagged, not accepted', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    app.fake.tamper(env.providerId!);
    await app.fake.sign(env.providerId!);
    expect(app.quotes.getQuote(id).quote.state).toBe('SENT');
    expect(app.store.flags()).toEqual([expect.objectContaining({ kind: 'signature-mismatch', ref: env.id })]);
    expect(app.store.contract(id)).toBeUndefined();
  });

  test('webhooks are verified: HMAC and replay window', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    const body = JSON.stringify({ eventId: 'evil', providerId: env.providerId, state: 'completed', recipients: [], declineReason: null, occurredAt: app.clock.now() });
    const ts = app.clock.now();
    await expect(app.quotes.handleWebhook({ 'x-fake-timestamp': ts, 'x-fake-signature': 'ab'.repeat(32) }, body)).rejects.toBeInstanceOf(WebhookVerificationError);
    const good = hmacSha256Hex('dev-webhook-secret', `${ts}.${body}`);
    app.clock.advanceMinutes(10);
    await expect(app.quotes.handleWebhook({ 'x-fake-timestamp': ts, 'x-fake-signature': good }, body)).rejects.toThrow(/replay window/);
    expect(app.quotes.getQuote(id).quote.state).toBe('SENT');
  });

  test('duplicate and out-of-order events are no-ops', async () => {
    const app = testApp();
    const id = approvedQuote(app);
    const env = await app.quotes.send('alice', id);
    await app.fake.view(env.providerId!);
    const delivered = app.fake.delivered.at(-1)!;
    await app.quotes.handleWebhook(delivered.headers, delivered.body); // duplicate
    await app.fake.sign(env.providerId!);
    await app.quotes.handleWebhook(delivered.headers, delivered.body); // late "delivered" after completion
    expect(app.quotes.getQuote(id).quote.state).toBe('CLOSED_WON');
    expect(app.quotes.consistencyCheck()).toEqual([]);
  });
});

describe('executed contract', () => {
  test('carries what billing and rev-rec need, and validates', async () => {
    const app = testApp();
    const id = approvedQuote(app, {
      accountId: 'acct-northwind',
      termMonths: 24,
      startDate: '2026-11-01',
      lines: [
        { lineId: 'L1', productId: 'plat', quantity: '100' },
        { lineId: 'L2', productId: 'onb', quantity: '1' },
      ],
    });
    const env = await app.quotes.send('alice', id);
    await app.fake.sign(env.providerId!);
    const c = app.quotes.contract(id);
    expect(validateExecutedContract(c)).toEqual([]);
    expect(c.term).toEqual({ startDate: '2026-11-01', endDate: '2028-10-31', months: 24, autoRenew: true, noticePeriodDays: 30 });
    const plat = c.lines.find((l) => l.productId === 'plat')!;
    expect(plat).toMatchObject({ billingFrequency: 'annual', recognitionMethod: 'ratable', serviceStartDate: '2026-11-01', serviceEndDate: '2028-10-31' });
    // SSP: $228 × 100 × 24/12
    expect(plat.standaloneSellingPriceMinorUnits).toBe('4560000');
    const onb = c.lines.find((l) => l.productId === 'onb')!;
    expect(onb).toMatchObject({ recognitionMethod: 'point-in-time', serviceEndDate: '2026-11-01' });
    expect(c.documentHash).toBe(app.store.documents(id)[0]!.sha256);
  });

  test('calendar arithmetic', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(termEnd('2026-11-01', 12)).toBe('2027-10-31');
    expect(termEnd('2028-02-29', 12)).toBe('2029-02-27');
  });
});
