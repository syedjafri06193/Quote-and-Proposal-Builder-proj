/**
 * DocuSign eSignature REST v2.1 adapter behind the ESignProvider interface.
 *
 * Status: written against the public API documentation; exercise it against
 * a DocuSign developer sandbox before production use. Access-token
 * acquisition (JWT grant) is injected so this file carries no secrets.
 *
 * Notes on the mapping:
 *  - DocuSign has no request-level idempotency keys. The key is written into
 *    an envelope custom field, and crash recovery searches for it.
 *  - Signature fields are placed by anchor text, never coordinates (§9.2).
 *  - Connect webhooks are verified with HMAC-SHA256 (X-DocuSign-Signature-1)
 *    and a replay window on generatedDateTime.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type ESignProvider,
  type EnvelopeRef,
  type EnvelopeRequest,
  type EnvelopeStatus,
  type ProviderEnvelopeState,
  type RecipientStatus,
  type WebhookEvent,
  WebhookVerificationError,
} from './provider.ts';

export type DocuSignConfig = {
  basePath: string; // e.g. https://demo.docusign.net/restapi
  accountId: string;
  hmacSecret: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

type DsRecipient = { recipientId: string; status: string };

function mapState(status: string, voidedReason?: string): ProviderEnvelopeState {
  switch (status) {
    case 'sent':
    case 'created':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'completed':
    case 'signed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'voided':
      return /expired/i.test(voidedReason ?? '') ? 'expired' : 'voided';
    default:
      return 'sent';
  }
}
function mapRecipient(r: DsRecipient): RecipientStatus {
  const s = r.status === 'completed' || r.status === 'signed' ? 'signed' : r.status === 'declined' ? 'declined' : r.status === 'delivered' ? 'delivered' : 'sent';
  return { recipientId: String(r.recipientId), status: s };
}

export class DocuSignProvider implements ESignProvider {
  readonly name = 'docusign';
  private readonly f: typeof fetch;
  constructor(private readonly cfg: DocuSignConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.cfg.getAccessToken();
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.f(`${this.cfg.basePath}/v2.1/accounts/${this.cfg.accountId}${path}`, init);
    if (!res.ok) throw new Error(`DocuSign ${method} ${path} → ${res.status}: ${await res.text()}`);
    return res;
  }

  async createEnvelope(req: EnvelopeRequest, idempotencyKey: string): Promise<EnvelopeRef> {
    const body = {
      emailSubject: req.emailSubject,
      status: 'sent',
      documents: [{ documentId: '1', name: req.documentName, fileExtension: 'pdf', documentBase64: Buffer.from(req.documentBytes).toString('base64') }],
      recipients: {
        signers: req.signers.map((s, i) => ({
          recipientId: s.recipientId,
          routingOrder: String(i + 1),
          name: s.name,
          email: s.email,
          tabs: {
            signHereTabs: [{ anchorString: req.anchors.signature, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-8', anchorIgnoreIfNotPresent: 'false' }],
            fullNameTabs: [{ anchorString: req.anchors.name, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-8' }],
            dateSignedTabs: [{ anchorString: req.anchors.date, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-8' }],
          },
        })),
      },
      customFields: {
        textCustomFields: [
          { name: 'idempotencyKey', value: idempotencyKey, show: 'false' },
          { name: 'quoteId', value: req.metadata.quoteId, show: 'false' },
          { name: 'quoteVersion', value: String(req.metadata.quoteVersion), show: 'false' },
          { name: 'contentHash', value: req.metadata.contentHash, show: 'false' },
        ],
      },
      notification: { useAccountDefaults: 'false', expirations: { expireEnabled: 'true', expireAfter: String(req.expiresInDays), expireWarn: '3' } },
    };
    const res = await this.call('POST', '/envelopes', body);
    const j = (await res.json()) as { envelopeId: string; status: string };
    return { providerId: j.envelopeId, state: mapState(j.status) };
  }

  async findByIdempotencyKey(key: string): Promise<EnvelopeRef | null> {
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const q = new URLSearchParams({ from_date: from, custom_field: `idempotencyKey=${key}` });
    const res = await this.call('GET', `/envelopes?${q}`);
    const j = (await res.json()) as { envelopes?: Array<{ envelopeId: string; status: string; voidedReason?: string }> };
    const e = j.envelopes?.[0];
    return e ? { providerId: e.envelopeId, state: mapState(e.status, e.voidedReason) } : null;
  }

  async getEnvelope(id: string): Promise<EnvelopeStatus> {
    const res = await this.call('GET', `/envelopes/${id}?include=recipients`);
    const j = (await res.json()) as {
      envelopeId: string;
      status: string;
      voidedReason?: string;
      statusChangedDateTime: string;
      recipients?: { signers?: Array<DsRecipient & { declinedReason?: string }> };
    };
    const signers = j.recipients?.signers ?? [];
    return {
      providerId: j.envelopeId,
      state: mapState(j.status, j.voidedReason),
      recipients: signers.map(mapRecipient),
      declineReason: signers.find((s) => s.declinedReason)?.declinedReason ?? null,
      updatedAt: j.statusChangedDateTime,
    };
  }

  async void(id: string, reason: string): Promise<void> {
    await this.call('PUT', `/envelopes/${id}`, { status: 'voided', voidedReason: reason });
  }

  async downloadCompleted(id: string): Promise<{ bytes: Uint8Array; certificate: Uint8Array }> {
    const doc = await this.call('GET', `/envelopes/${id}/documents/combined`);
    const cert = await this.call('GET', `/envelopes/${id}/documents/certificate`);
    return { bytes: new Uint8Array(await doc.arrayBuffer()), certificate: new Uint8Array(await cert.arrayBuffer()) };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, nowIso: string): WebhookEvent {
    const sig = headers['x-docusign-signature-1'];
    if (!sig) throw new WebhookVerificationError('missing X-DocuSign-Signature-1');
    const expected = createHmac('sha256', this.cfg.hmacSecret).update(rawBody).digest('base64');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookVerificationError('bad signature');
    const j = JSON.parse(rawBody) as {
      event: string;
      generatedDateTime: string;
      data: { envelopeId: string; envelopeSummary?: { status: string; voidedReason?: string; recipients?: { signers?: DsRecipient[] } } };
    };
    if (Math.abs(Date.parse(nowIso) - Date.parse(j.generatedDateTime)) > 15 * 60_000) throw new WebhookVerificationError('event outside replay window');
    const sum = j.data.envelopeSummary;
    return {
      eventId: `${j.data.envelopeId}:${j.event}:${j.generatedDateTime}`,
      providerId: j.data.envelopeId,
      state: mapState(sum?.status ?? j.event.replace(/^envelope-/, ''), sum?.voidedReason),
      recipients: (sum?.recipients?.signers ?? []).map(mapRecipient),
      declineReason: null,
      occurredAt: j.generatedDateTime,
    };
  }
}
