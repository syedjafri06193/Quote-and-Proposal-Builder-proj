/**
 * E-signature provider abstraction (design guide §10.1): just enough to test
 * without network calls. Implementations: FakeESignProvider (drives every
 * state, for tests and the demo) and DocuSignProvider.
 */
export type ProviderEnvelopeState = 'sent' | 'delivered' | 'completed' | 'declined' | 'voided' | 'expired';

export type EnvelopeRequest = {
  documentBytes: Uint8Array;
  documentName: string;
  emailSubject: string;
  signers: Array<{ recipientId: string; name: string; email: string }>;
  anchors: { signature: string; name: string; date: string };
  metadata: { quoteId: string; quoteVersion: number; contentHash: string };
  expiresInDays: number;
};

export type RecipientStatus = { recipientId: string; status: 'sent' | 'delivered' | 'signed' | 'declined' };

export type EnvelopeStatus = {
  providerId: string;
  state: ProviderEnvelopeState;
  recipients: RecipientStatus[];
  declineReason: string | null;
  updatedAt: string;
};

export type EnvelopeRef = { providerId: string; state: ProviderEnvelopeState };

export type WebhookEvent = {
  eventId: string;
  providerId: string;
  state: ProviderEnvelopeState;
  recipients: RecipientStatus[];
  declineReason: string | null;
  occurredAt: string;
};

export class WebhookVerificationError extends Error {}

export interface ESignProvider {
  readonly name: string;
  createEnvelope(req: EnvelopeRequest, idempotencyKey: string): Promise<EnvelopeRef>;
  /** Crash recovery: find an envelope created with this key, if the provider has one. */
  findByIdempotencyKey(idempotencyKey: string): Promise<EnvelopeRef | null>;
  getEnvelope(providerId: string): Promise<EnvelopeStatus>;
  void(providerId: string, reason: string): Promise<void>;
  downloadCompleted(providerId: string): Promise<{ bytes: Uint8Array; certificate: Uint8Array }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, nowIso: string): WebhookEvent;
}

const RANK: Record<ProviderEnvelopeState, number> = { sent: 0, delivered: 1, completed: 2, declined: 2, voided: 2, expired: 2 };
export const isTerminalProviderState = (s: ProviderEnvelopeState): boolean => RANK[s] === 2;
/** Envelope states only move forward; a late or duplicate event for an earlier state is ignored. */
export const isForward = (from: ProviderEnvelopeState | 'creating' | 'mismatch', to: ProviderEnvelopeState): boolean =>
  from === 'creating' ? true : from === 'mismatch' ? false : RANK[to] > RANK[from];
