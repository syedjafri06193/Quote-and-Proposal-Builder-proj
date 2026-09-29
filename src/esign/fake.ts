/**
 * A fake e-signature provider that can be driven through every state —
 * delivered, completed, declined, expired, voided — and can drop webhooks,
 * crash mid-create, or return a tampered document. This is what makes the
 * reconciliation and integrity paths testable without a sandbox account.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqualHex } from '../util/hash.ts';
import {
  type ESignProvider,
  type EnvelopeRef,
  type EnvelopeRequest,
  type EnvelopeStatus,
  type ProviderEnvelopeState,
  type RecipientStatus,
  type WebhookEvent,
  WebhookVerificationError,
  isTerminalProviderState,
} from './provider.ts';

type FakeEnvelope = {
  id: string;
  key: string;
  req: EnvelopeRequest;
  state: ProviderEnvelopeState;
  recipients: RecipientStatus[];
  declineReason: string | null;
  updatedAt: string;
  audit: Array<{ at: string; event: string; recipientId?: string; ip: string }>;
  tampered: boolean;
};

export type WebhookDelivery = { headers: Record<string, string>; body: string };

export class FakeESignProvider implements ESignProvider {
  readonly name = 'fake';
  /** Distinguishes provider ids across process restarts (the fake keeps its envelopes in memory). */
  private readonly instance = randomUUID().slice(0, 8);
  private envelopes = new Map<string, FakeEnvelope>();
  private byKey = new Map<string, string>();
  private seq = 0;
  private eventSeq = 0;
  /** When true, webhooks are silently dropped (endpoint down, provider incident…). */
  dropWebhooks = false;
  /** When set, the next createEnvelope creates the envelope and then throws (crash between call and response). */
  failAfterNextCreate = false;
  readonly delivered: WebhookDelivery[] = [];
  readonly dropped: WebhookDelivery[] = [];

  constructor(
    private readonly secret: string,
    private readonly clock: () => string,
    private sink: ((d: WebhookDelivery) => Promise<void>) | null = null,
  ) {}

  setSink(sink: (d: WebhookDelivery) => Promise<void>): void {
    this.sink = sink;
  }

  async createEnvelope(req: EnvelopeRequest, idempotencyKey: string): Promise<EnvelopeRef> {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      const e = this.envelopes.get(existing)!;
      return { providerId: e.id, state: e.state };
    }
    const id = `fake-${this.instance}-${++this.seq}`;
    const now = this.clock();
    const env: FakeEnvelope = {
      id,
      key: idempotencyKey,
      req: { ...req, documentBytes: new Uint8Array(req.documentBytes) },
      state: 'sent',
      recipients: req.signers.map((s) => ({ recipientId: s.recipientId, status: 'sent' })),
      declineReason: null,
      updatedAt: now,
      audit: [{ at: now, event: 'envelope-sent', ip: '203.0.113.10' }],
      tampered: false,
    };
    this.envelopes.set(id, env);
    this.byKey.set(idempotencyKey, id);
    if (this.failAfterNextCreate) {
      this.failAfterNextCreate = false;
      throw new Error('simulated network failure after envelope creation');
    }
    return { providerId: id, state: 'sent' };
  }

  async findByIdempotencyKey(key: string): Promise<EnvelopeRef | null> {
    const id = this.byKey.get(key);
    if (!id) return null;
    const e = this.envelopes.get(id)!;
    return { providerId: e.id, state: e.state };
  }

  async getEnvelope(id: string): Promise<EnvelopeStatus> {
    const e = this.must(id);
    return { providerId: e.id, state: e.state, recipients: e.recipients.map((r) => ({ ...r })), declineReason: e.declineReason, updatedAt: e.updatedAt };
  }

  async void(id: string, reason: string): Promise<void> {
    const e = this.must(id);
    if (isTerminalProviderState(e.state)) throw new Error(`cannot void envelope in state ${e.state}`);
    await this.transition(e, 'voided', { reason });
  }

  async downloadCompleted(id: string): Promise<{ bytes: Uint8Array; certificate: Uint8Array }> {
    const e = this.must(id);
    if (e.state !== 'completed') throw new Error(`envelope ${id} is not completed`);
    const doc = await PDFDocument.load(e.req.documentBytes, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.HelveticaOblique);
    const last = doc.getPages().at(-1)!;
    // The overlay: a signature stamp. Bytes change; the embedded content reference must not.
    last.drawText(`Signed electronically by ${e.req.signers.map((s) => s.name).join(', ')} at ${e.updatedAt}`, {
      x: 54,
      y: 70,
      size: 8,
      font,
      color: rgb(0.1, 0.3, 0.6),
    });
    if (e.tampered) doc.setKeywords(['qpb-content:' + '0'.repeat(64)]);
    const bytes = await doc.save({ useObjectStreams: false });
    const certificate = new TextEncoder().encode(
      JSON.stringify({ provider: 'fake', envelopeId: e.id, signers: e.req.signers, audit: e.audit }, null, 2),
    );
    return { bytes, certificate };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, nowIso: string): WebhookEvent {
    const sig = headers['x-fake-signature'];
    const ts = headers['x-fake-timestamp'];
    if (!sig || !ts) throw new WebhookVerificationError('missing signature headers');
    const age = Math.abs(Date.parse(nowIso) - Date.parse(ts));
    if (!Number.isFinite(age) || age > 5 * 60_000) throw new WebhookVerificationError('timestamp outside replay window');
    const expected = hmacSha256Hex(this.secret, `${ts}.${rawBody}`);
    if (!safeEqualHex(sig, expected)) throw new WebhookVerificationError('bad signature');
    return JSON.parse(rawBody) as WebhookEvent;
  }

  // ── controls to drive every state ──
  async view(id: string, recipientId?: string): Promise<void> {
    const e = this.must(id);
    for (const r of e.recipients) if (!recipientId || r.recipientId === recipientId) if (r.status === 'sent') r.status = 'delivered';
    if (e.state === 'sent') await this.transition(e, 'delivered', { recipientId: recipientId ?? 'all' });
  }
  async sign(id: string, recipientId?: string): Promise<void> {
    const e = this.must(id);
    if (isTerminalProviderState(e.state)) throw new Error(`cannot sign envelope in state ${e.state}`);
    for (const r of e.recipients) if (!recipientId || r.recipientId === recipientId) r.status = 'signed';
    e.audit.push({ at: this.clock(), event: 'recipient-signed', recipientId: recipientId ?? 'all', ip: '198.51.100.7' });
    // Envelope completes only when every recipient has signed — per-recipient tracking (design guide §10.5).
    if (e.recipients.every((r) => r.status === 'signed')) await this.transition(e, 'completed', {});
    else await this.emit(e);
  }
  async decline(id: string, reason: string): Promise<void> {
    const e = this.must(id);
    if (isTerminalProviderState(e.state)) throw new Error(`cannot decline envelope in state ${e.state}`);
    e.declineReason = reason;
    e.recipients[0]!.status = 'declined';
    await this.transition(e, 'declined', { reason });
  }
  async expire(id: string): Promise<void> {
    const e = this.must(id);
    if (isTerminalProviderState(e.state)) throw new Error(`cannot expire envelope in state ${e.state}`);
    await this.transition(e, 'expired', {});
  }
  tamper(id: string): void {
    this.must(id).tampered = true;
  }
  /** Re-send the most recent dropped deliveries (e.g. provider retry). */
  async redeliverDropped(): Promise<void> {
    const list = this.dropped.splice(0);
    for (const d of list) await this.sink?.(d);
  }
  list(): Array<{ id: string; state: ProviderEnvelopeState; quoteId: string }> {
    return [...this.envelopes.values()].map((e) => ({ id: e.id, state: e.state, quoteId: e.req.metadata.quoteId }));
  }

  private must(id: string): FakeEnvelope {
    const e = this.envelopes.get(id);
    if (!e) throw new Error(`no envelope ${id}`);
    return e;
  }

  private async transition(e: FakeEnvelope, to: ProviderEnvelopeState, detail: Record<string, string>): Promise<void> {
    e.state = to;
    e.updatedAt = this.clock();
    e.audit.push({ at: e.updatedAt, event: `envelope-${to}`, ip: '203.0.113.10', ...detail });
    await this.emit(e);
  }

  private async emit(e: FakeEnvelope): Promise<void> {
    const ev: WebhookEvent = {
      eventId: `evt-${++this.eventSeq}`,
      providerId: e.id,
      state: e.state,
      recipients: e.recipients.map((r) => ({ ...r })),
      declineReason: e.declineReason,
      occurredAt: e.updatedAt,
    };
    const body = JSON.stringify(ev);
    const ts = this.clock();
    const d: WebhookDelivery = { headers: { 'x-fake-timestamp': ts, 'x-fake-signature': hmacSha256Hex(this.secret, `${ts}.${body}`) }, body };
    if (this.dropWebhooks || !this.sink) {
      this.dropped.push(d);
      return;
    }
    this.delivered.push(d);
    await this.sink(d);
  }
}
