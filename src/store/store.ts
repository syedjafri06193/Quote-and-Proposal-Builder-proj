/**
 * Append-only store. In-memory with optional JSON-file persistence so the demo
 * server survives restarts without a database. The shapes mirror
 * db/migrations/001_init.sql one-to-one; a Postgres implementation of the
 * same interface is a mechanical port.
 *
 * Invariant: nothing here updates quote data in place. Quote versions,
 * events, approvals, documents and rule sets are insert-only. The only
 * mutable fields are the denormalized `quote.state` and `envelope.state`,
 * both reconstructable from their event logs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApprovalPlan } from '../approvals/approvals.ts';
import type { QuoteEventType, QuoteState } from '../approvals/stateMachine.ts';
import type { PriceBook, QuoteConfig, RuleSetDefinition } from '../pricing/types.ts';
import type { Account, User } from '../seed/data.ts';
import type { SimulationReport } from '../rules/simulate.ts';
import type { ExecutedContract } from '../contracts/contract.ts';

export type RuleSetRecord = {
  version: number;
  definition: RuleSetDefinition;
  contentHash: string;
  effectiveFrom: string;
  publishedAt: string;
  publishedBy: string;
  approvedBy: string;
  draftId: string | null;
  notes: string;
};

export type RuleDraftState = 'DRAFT' | 'SIMULATED' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'REJECTED';

export type RuleDraft = {
  id: string;
  title: string;
  basedOnVersion: number;
  definition: RuleSetDefinition;
  effectiveFrom: string;
  author: string;
  state: RuleDraftState;
  createdAt: string;
  updatedAt: string;
  simulation: SimulationReport | null;
  simulatedHash: string | null;
  publishedVersion: number | null;
  history: Array<{ at: string; actor: string; action: string; note?: string }>;
};

export type QuoteRecord = {
  id: string;
  number: number;
  accountId: string;
  ownerId: string;
  state: QuoteState;
  createdAt: string;
  nonStandard: boolean;
};

export type QuoteVersionRecord = {
  quoteId: string;
  version: number;
  config: QuoteConfig;
  /** Serialized PricedQuote (codec.serialize) — the materialized result, trace included. */
  materialized: string;
  ruleSetVersion: number;
  priceBookVersion: number;
  approvalFingerprint: string;
  contentHash: string;
  pricedAt: string;
  createdBy: string;
};

export type QuoteEvent = {
  id: number;
  quoteId: string;
  quoteVersion: number | null;
  type: QuoteEventType;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type PlanRecord = {
  id: string;
  quoteId: string;
  quoteVersion: number;
  plan: ApprovalPlan;
  submittedAt: string;
  submittedBy: string;
  repNote: string;
};

export type ApprovalRecord = {
  id: string;
  quoteId: string;
  quoteVersion: number;
  planId: string;
  slotId: string;
  /** Stable identity of the requirement across re-submissions: ruleId + eligible set. */
  slotKey: string;
  approverId: string;
  onBehalfOf: string | null;
  role: string;
  fingerprint: string;
  decision: 'approved' | 'rejected' | 'conditional';
  conditions: string | null;
  comment: string | null;
  decidedAt: string;
};

export type Delegation = { id: string; fromUserId: string; toUserId: string; from: string; until: string; createdAt: string; reason: string };

export type DocumentRecord = {
  id: string;
  quoteId: string;
  quoteVersion: number;
  templateVersion: number;
  sha256: string;
  contentHash: string;
  storageKey: string;
  generatedAt: string;
};

export type EnvelopeState = 'creating' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided' | 'expired' | 'mismatch';

export type EnvelopeRecord = {
  id: string;
  quoteId: string;
  quoteVersion: number;
  documentId: string;
  provider: string;
  providerId: string | null;
  idempotencyKey: string;
  state: EnvelopeState;
  recipients: Array<{ id: string; name: string; email: string; status: string }>;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  appliedEventIds: string[];
  declineReason: string | null;
};

export type EnvelopeEvent = { envelopeId: string; source: 'webhook' | 'reconcile' | 'local'; from: EnvelopeState; to: EnvelopeState; eventId: string; at: string; drift: boolean };

export type ContractRecord = { contract: ExecutedContract; signedDocKey: string; certificateKey: string; storedAt: string };

export type OutboxRecord = { id: number; topic: string; idempotencyKey: string; payload: unknown; publishedAt: string };

export type ReviewFlag = { id: string; kind: string; ref: string; message: string; at: string };

export type TemplateRecord = { version: number; name: string; publishedAt: string; body: TemplateBody };
export type TemplateBody = {
  companyName: string;
  companyAddress: string;
  termsSummary: string[];
  slaAppendix: string[];
  footerNote: string;
};

type Data = {
  seq: Record<string, number>;
  users: User[];
  accounts: Account[];
  priceBooks: PriceBook[];
  ruleSets: RuleSetRecord[];
  ruleDrafts: RuleDraft[];
  templates: TemplateRecord[];
  quotes: QuoteRecord[];
  quoteVersions: QuoteVersionRecord[];
  events: QuoteEvent[];
  plans: PlanRecord[];
  approvals: ApprovalRecord[];
  delegations: Delegation[];
  documents: DocumentRecord[];
  envelopes: EnvelopeRecord[];
  envelopeEvents: EnvelopeEvent[];
  contracts: ContractRecord[];
  outbox: OutboxRecord[];
  flags: ReviewFlag[];
  blobs: Record<string, string>; // base64
};

const empty = (): Data => ({
  seq: {},
  users: [],
  accounts: [],
  priceBooks: [],
  ruleSets: [],
  ruleDrafts: [],
  templates: [],
  quotes: [],
  quoteVersions: [],
  events: [],
  plans: [],
  approvals: [],
  delegations: [],
  documents: [],
  envelopes: [],
  envelopeEvents: [],
  contracts: [],
  outbox: [],
  flags: [],
  blobs: {},
});

export class DuplicateKeyError extends Error {}

const clone = <T>(v: T): T => structuredClone(v);

export class Store {
  private d: Data;
  constructor(private readonly file: string | null = null) {
    this.d = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Data) : empty();
  }

  get isEmpty(): boolean {
    return this.d.ruleSets.length === 0;
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d));
    renameSync(tmp, this.file);
  }

  nextId(kind: string): number {
    const n = (this.d.seq[kind] ?? 0) + 1;
    this.d.seq[kind] = n;
    return n;
  }

  // ── directory ──
  putUsers(users: User[]): void {
    this.d.users = clone(users);
    this.persist();
  }
  users(): User[] {
    return clone(this.d.users);
  }
  user(id: string): User | undefined {
    return clone(this.d.users.find((u) => u.id === id));
  }
  putAccounts(a: Account[]): void {
    this.d.accounts = clone(a);
    this.persist();
  }
  accounts(): Account[] {
    return clone(this.d.accounts);
  }
  account(id: string): Account | undefined {
    return clone(this.d.accounts.find((a) => a.id === id));
  }

  // ── price books (immutable) ──
  insertPriceBook(pb: PriceBook): void {
    if (this.d.priceBooks.some((p) => p.version === pb.version)) throw new DuplicateKeyError(`price book v${pb.version} exists`);
    this.d.priceBooks.push(clone(pb));
    this.persist();
  }
  priceBook(version: number): PriceBook | undefined {
    return clone(this.d.priceBooks.find((p) => p.version === version));
  }
  latestPriceBook(): PriceBook {
    const pb = [...this.d.priceBooks].sort((a, b) => b.version - a.version)[0];
    if (!pb) throw new Error('no price book published');
    return clone(pb);
  }

  // ── rule sets (immutable) ──
  insertRuleSet(r: RuleSetRecord): void {
    if (this.d.ruleSets.some((x) => x.version === r.version)) throw new DuplicateKeyError(`rule set v${r.version} exists`);
    this.d.ruleSets.push(clone(r));
    this.persist();
  }
  ruleSet(version: number): RuleSetRecord | undefined {
    return clone(this.d.ruleSets.find((r) => r.version === version));
  }
  ruleSets(): RuleSetRecord[] {
    return clone([...this.d.ruleSets].sort((a, b) => a.version - b.version));
  }

  // ── rule drafts (a working area; mutable by design, with history) ──
  insertDraft(d: RuleDraft): void {
    this.d.ruleDrafts.push(clone(d));
    this.persist();
  }
  saveDraft(d: RuleDraft): void {
    const i = this.d.ruleDrafts.findIndex((x) => x.id === d.id);
    if (i < 0) throw new Error(`no draft ${d.id}`);
    if (this.d.ruleDrafts[i]!.state === 'PUBLISHED') throw new Error('published drafts are immutable');
    this.d.ruleDrafts[i] = clone(d);
    this.persist();
  }
  draft(id: string): RuleDraft | undefined {
    return clone(this.d.ruleDrafts.find((x) => x.id === id));
  }
  drafts(): RuleDraft[] {
    return clone(this.d.ruleDrafts);
  }

  // ── templates (immutable) ──
  insertTemplate(t: TemplateRecord): void {
    if (this.d.templates.some((x) => x.version === t.version)) throw new DuplicateKeyError(`template v${t.version} exists`);
    this.d.templates.push(clone(t));
    this.persist();
  }
  template(version: number): TemplateRecord | undefined {
    return clone(this.d.templates.find((t) => t.version === version));
  }
  latestTemplate(): TemplateRecord {
    const t = [...this.d.templates].sort((a, b) => b.version - a.version)[0];
    if (!t) throw new Error('no template published');
    return clone(t);
  }

  // ── quotes ──
  insertQuote(q: QuoteRecord): void {
    this.d.quotes.push(clone(q));
    this.persist();
  }
  quote(id: string): QuoteRecord | undefined {
    return clone(this.d.quotes.find((q) => q.id === id));
  }
  quotes(): QuoteRecord[] {
    return clone(this.d.quotes);
  }
  /** The single sanctioned mutation: the denormalized state column. */
  setQuoteState(id: string, state: QuoteState): void {
    const q = this.d.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`no quote ${id}`);
    q.state = state;
    this.persist();
  }

  insertQuoteVersion(v: QuoteVersionRecord): void {
    if (this.d.quoteVersions.some((x) => x.quoteId === v.quoteId && x.version === v.version))
      throw new DuplicateKeyError(`quote ${v.quoteId} v${v.version} exists`);
    this.d.quoteVersions.push(clone(v));
    this.persist();
  }
  quoteVersion(quoteId: string, version?: number): QuoteVersionRecord | undefined {
    const vs = this.d.quoteVersions.filter((x) => x.quoteId === quoteId);
    const v = version === undefined ? vs.sort((a, b) => b.version - a.version)[0] : vs.find((x) => x.version === version);
    return clone(v);
  }
  quoteVersions(quoteId?: string): QuoteVersionRecord[] {
    return clone(
      this.d.quoteVersions
        .filter((x) => quoteId === undefined || x.quoteId === quoteId)
        .sort((a, b) => a.quoteId.localeCompare(b.quoteId) || a.version - b.version),
    );
  }

  appendEvent(e: Omit<QuoteEvent, 'id'>): QuoteEvent {
    const ev = { ...clone(e), id: this.nextId('event') };
    this.d.events.push(ev);
    this.persist();
    return clone(ev);
  }
  events(quoteId?: string): QuoteEvent[] {
    return clone(this.d.events.filter((e) => quoteId === undefined || e.quoteId === quoteId));
  }

  insertPlan(p: PlanRecord): void {
    this.d.plans.push(clone(p));
    this.persist();
  }
  plans(quoteId: string): PlanRecord[] {
    return clone(this.d.plans.filter((p) => p.quoteId === quoteId));
  }

  insertApproval(a: ApprovalRecord): void {
    this.d.approvals.push(clone(a));
    this.persist();
  }
  approvals(quoteId: string): ApprovalRecord[] {
    return clone(this.d.approvals.filter((a) => a.quoteId === quoteId));
  }

  insertDelegation(d: Delegation): void {
    this.d.delegations.push(clone(d));
    this.persist();
  }
  delegations(): Delegation[] {
    return clone(this.d.delegations);
  }

  // ── documents & blobs ──
  putBlob(key: string, bytes: Uint8Array): void {
    if (this.d.blobs[key] !== undefined) {
      if (this.d.blobs[key] !== Buffer.from(bytes).toString('base64')) throw new DuplicateKeyError(`blob ${key} exists with different content`);
      return;
    }
    this.d.blobs[key] = Buffer.from(bytes).toString('base64');
    this.persist();
  }
  blob(key: string): Uint8Array | undefined {
    const b = this.d.blobs[key];
    return b === undefined ? undefined : new Uint8Array(Buffer.from(b, 'base64'));
  }
  insertDocument(doc: DocumentRecord): void {
    this.d.documents.push(clone(doc));
    this.persist();
  }
  documents(quoteId: string): DocumentRecord[] {
    return clone(this.d.documents.filter((d) => d.quoteId === quoteId));
  }
  document(id: string): DocumentRecord | undefined {
    return clone(this.d.documents.find((d) => d.id === id));
  }

  // ── envelopes ──
  insertEnvelope(e: EnvelopeRecord): void {
    if (this.d.envelopes.some((x) => x.idempotencyKey === e.idempotencyKey)) throw new DuplicateKeyError(`idempotency key exists`);
    this.d.envelopes.push(clone(e));
    this.persist();
  }
  updateEnvelope(id: string, patch: Partial<EnvelopeRecord>): EnvelopeRecord {
    const e = this.d.envelopes.find((x) => x.id === id);
    if (!e) throw new Error(`no envelope ${id}`);
    Object.assign(e, clone(patch));
    this.persist();
    return clone(e);
  }
  envelope(id: string): EnvelopeRecord | undefined {
    return clone(this.d.envelopes.find((x) => x.id === id));
  }
  envelopeByKey(key: string): EnvelopeRecord | undefined {
    return clone(this.d.envelopes.find((x) => x.idempotencyKey === key));
  }
  envelopeByProviderId(pid: string): EnvelopeRecord | undefined {
    return clone(this.d.envelopes.find((x) => x.providerId === pid));
  }
  envelopes(quoteId?: string): EnvelopeRecord[] {
    return clone(this.d.envelopes.filter((e) => quoteId === undefined || e.quoteId === quoteId));
  }
  appendEnvelopeEvent(e: EnvelopeEvent): void {
    this.d.envelopeEvents.push(clone(e));
    this.persist();
  }
  envelopeEvents(envelopeId?: string): EnvelopeEvent[] {
    return clone(this.d.envelopeEvents.filter((e) => envelopeId === undefined || e.envelopeId === envelopeId));
  }

  // ── contracts & outbox ──
  insertContract(c: ContractRecord): void {
    if (this.d.contracts.some((x) => x.contract.quoteId === c.contract.quoteId)) throw new DuplicateKeyError('contract exists for quote');
    this.d.contracts.push(clone(c));
    this.persist();
  }
  contract(quoteId: string): ContractRecord | undefined {
    return clone(this.d.contracts.find((c) => c.contract.quoteId === quoteId));
  }
  contracts(): ContractRecord[] {
    return clone(this.d.contracts);
  }
  /** Returns false if the idempotency key was already published. */
  appendOutbox(topic: string, idempotencyKey: string, payload: unknown, at: string): boolean {
    if (this.d.outbox.some((o) => o.idempotencyKey === idempotencyKey)) return false;
    this.d.outbox.push({ id: this.nextId('outbox'), topic, idempotencyKey, payload: clone(payload), publishedAt: at });
    this.persist();
    return true;
  }
  outbox(topic?: string): OutboxRecord[] {
    return clone(this.d.outbox.filter((o) => topic === undefined || o.topic === topic));
  }

  flag(f: Omit<ReviewFlag, 'id'>): void {
    this.d.flags.push({ ...f, id: `flag-${this.nextId('flag')}` });
    this.persist();
  }
  flags(): ReviewFlag[] {
    return clone(this.d.flags);
  }
}
