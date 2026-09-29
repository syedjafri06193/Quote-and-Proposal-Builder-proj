/**
 * Quote lifecycle: immutable versions, approvals with fingerprints,
 * deterministic documents, e-signature with reconciliation, and the
 * structured contract handoff.
 */
import type { Store, QuoteRecord, QuoteVersionRecord, QuoteEvent, PlanRecord, ApprovalRecord, EnvelopeRecord, DocumentRecord } from '../store/store.ts';
import type { PriceBook, PricedQuote, QuoteConfig, RuleSet } from '../pricing/types.ts';
import { priceQuote as defaultEngine } from '../pricing/pipeline.ts';
import { serialize, deserialize } from '../pricing/codec.ts';
import { renderTrace } from '../pricing/trace.ts';
import { format } from '../money/money.ts';
import { hashJson, sha256 } from '../util/hash.ts';
import {
  approvalFingerprint,
  resolvePlan,
  escalationDue,
  DEFAULT_CALENDAR,
  ApprovalResolutionError,
  type ApprovalPlan,
  type ApprovalSlot,
  type BusinessCalendar,
} from '../approvals/approvals.ts';
import { nextState, canApply, fold, TERMINAL, type QuoteEventType, type QuoteState } from '../approvals/stateMachine.ts';
import { buildRenderModel, generateProposalPdf, extractContentHash, ANCHORS } from '../documents/generate.ts';
import type { ESignProvider, ProviderEnvelopeState, WebhookEvent } from '../esign/provider.ts';
import { isForward } from '../esign/provider.ts';
import { buildExecutedContract, type ExecutedContract } from '../contracts/contract.ts';
import { PricingError } from '../pricing/types.ts';
import { RuleService } from './rules.ts';
import { ApprovalInvalidatedError, conflict, forbidden, invalid, notFound, type Clock } from './errors.ts';

export type Engine = (c: QuoteConfig, rs: RuleSet, pb: PriceBook) => PricedQuote;

export type QuoteView = {
  quote: QuoteRecord;
  version: QuoteVersionRecord;
  priced: PricedQuote;
  versions: number[];
};

export type ApprovalProgress = {
  plan: PlanRecord | null;
  fingerprintCurrent: boolean;
  activeStage: number | null;
  stages: Array<{
    index: number;
    status: 'done' | 'active' | 'waiting' | 'rejected';
    slots: Array<ApprovalSlot & { slotKey: string; status: 'approved' | 'conditional' | 'rejected' | 'pending'; decidedBy: string | null; onBehalfOf: string | null; conditions: string | null; escalatedTo: string[] }>;
  }>;
};

const ENVELOPE_TERMINAL: ReadonlySet<string> = new Set(['completed', 'declined', 'voided', 'expired', 'mismatch']);

export class QuoteService {
  readonly rules: RuleService;
  private readonly listeners: Array<(topic: string, payload: unknown) => void> = [];

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly provider: ESignProvider,
    private readonly engine: Engine = defaultEngine,
    private readonly calendar: BusinessCalendar = DEFAULT_CALENDAR,
    private readonly log: (msg: string, data?: unknown) => void = () => {},
  ) {
    this.rules = new RuleService(store, clock);
  }

  /** Downstream consumers (billing, provisioning, CRM) subscribe here. */
  subscribe(fn: (topic: string, payload: unknown) => void): void {
    this.listeners.push(fn);
  }

  // ───────────────────────── helpers ─────────────────────────

  private user(id: string) {
    const u = this.store.user(id);
    if (!u) throw forbidden(`unknown user ${id}`);
    return u;
  }
  private mustQuote(id: string): QuoteRecord {
    const q = this.store.quote(id);
    if (!q) throw notFound(`quote ${id}`);
    return q;
  }
  private mustVersion(id: string, v?: number): QuoteVersionRecord {
    const qv = this.store.quoteVersion(id, v);
    if (!qv) throw notFound(`quote ${id}${v ? ` v${v}` : ''}`);
    return qv;
  }
  private priceBook(v?: number): PriceBook {
    const pb = v === undefined ? this.store.latestPriceBook() : this.store.priceBook(v);
    if (!pb) throw notFound(`price book v${v}`);
    return pb;
  }
  private requireOwnerOrDesk(actor: string, q: QuoteRecord): void {
    const u = this.user(actor);
    if (q.ownerId !== actor && !u.roles.includes('deal-desk')) throw forbidden(`${actor} does not own quote Q-${q.number}`);
  }

  /** Append an event, apply the state machine, update the denormalized state column. */
  private transition(quoteId: string, version: number | null, type: QuoteEventType, actor: string, payload: Record<string, unknown> = {}): QuoteEvent {
    const q = this.mustQuote(quoteId);
    const to = nextState(type === 'created' ? null : q.state, { type, payload });
    const ev = this.store.appendEvent({ quoteId, quoteVersion: version, type, actor, payload, occurredAt: this.clock.now() });
    if (to !== q.state) this.store.setQuoteState(quoteId, to);
    return ev;
  }

  private price(config: QuoteConfig, rs: RuleSet, pb: PriceBook): PricedQuote {
    try {
      return this.engine(config, rs, pb);
    } catch (e) {
      if (e instanceof PricingError) throw invalid(e.message, e.issues);
      throw e;
    }
  }

  private writeVersion(quoteId: string, version: number, config: QuoteConfig, priced: PricedQuote, actor: string): QuoteVersionRecord {
    const materialized = serialize(priced);
    const rec: QuoteVersionRecord = {
      quoteId,
      version,
      config,
      materialized,
      ruleSetVersion: priced.ruleSetVersion,
      priceBookVersion: priced.priceBookVersion,
      approvalFingerprint: approvalFingerprint(priced),
      contentHash: sha256(materialized + '\n' + hashJson(config)),
      pricedAt: this.clock.now(),
      createdBy: actor,
    };
    this.store.insertQuoteVersion(rec);
    return rec;
  }

  private normalizeConfig(input: Partial<QuoteConfig> & Pick<QuoteConfig, 'accountId' | 'lines'>): QuoteConfig {
    const acct = this.store.account(input.accountId);
    if (!acct) throw invalid(`unknown account ${input.accountId}`);
    const today = this.clock.now().slice(0, 10);
    const cfg: QuoteConfig = {
      quoteType: input.quoteType ?? 'standard',
      currency: input.currency ?? 'USD',
      accountId: acct.id,
      segment: input.segment ?? acct.segment,
      channel: input.channel ?? 'direct',
      promoCodes: [...(input.promoCodes ?? [])].map((p) => p.trim().toUpperCase()).filter(Boolean).sort(),
      asOf: input.asOf ?? today,
      startDate: input.startDate ?? today,
      termMonths: input.termMonths ?? 12,
      paymentTerms: input.paymentTerms ?? { netDays: 30, method: 'ACH' },
      legalTermsVersion: input.legalTermsVersion ?? 'std-2026.1',
      autoRenew: input.autoRenew ?? true,
      noticePeriodDays: input.noticePeriodDays ?? 30,
      lines: input.lines.map((l) => ({ ...l })),
      cover: input.cover ?? { title: 'Proposal', intro: '', preparedFor: acct.signer.name },
    };
    if (input.nonStandardReason !== undefined) cfg.nonStandardReason = input.nonStandardReason;
    if (input.orderManualDiscountBp !== undefined) cfg.orderManualDiscountBp = input.orderManualDiscountBp;
    return cfg;
  }

  // ───────────────────────── read path: never prices ─────────────────────────

  /**
   * Reading is a read. It returns the materialized result and never invokes
   * the pricing engine (design guide §4.2) — tested with an engine that throws.
   */
  getQuote(quoteId: string, version?: number): QuoteView {
    const quote = this.mustQuote(quoteId);
    const qv = this.mustVersion(quoteId, version);
    return {
      quote,
      version: qv,
      priced: deserialize<PricedQuote>(qv.materialized),
      versions: this.store.quoteVersions(quoteId).map((v) => v.version),
    };
  }

  listQuotes(): Array<QuoteRecord & { total: string; accountName: string; latestVersion: number }> {
    return this.store
      .quotes()
      .sort((a, b) => b.number - a.number)
      .map((q) => {
        const v = this.mustVersion(q.id);
        const p = deserialize<PricedQuote>(v.materialized);
        return { ...q, total: renderMoney(p.total), accountName: this.store.account(q.accountId)?.name ?? q.accountId, latestVersion: v.version };
      });
  }

  traceText(quoteId: string, version?: number): string {
    return renderTrace(this.getQuote(quoteId, version).priced);
  }

  // ───────────────────────── write path ─────────────────────────

  createQuote(actor: string, input: Partial<QuoteConfig> & Pick<QuoteConfig, 'accountId' | 'lines'>): QuoteView {
    const u = this.user(actor);
    if (!u.roles.some((r) => r === 'rep' || r === 'sales-manager' || r === 'deal-desk')) throw forbidden(`${actor} cannot create quotes`);
    const config = this.normalizeConfig(input);
    const rs = this.rules.current();
    const priced = this.price(config, rs, this.priceBook());
    const id = `q-${this.store.nextId('quote')}`;
    const number = 1000 + this.store.nextId('quoteNumber');
    this.store.insertQuote({ id, number, accountId: config.accountId, ownerId: actor, state: 'DRAFT', createdAt: this.clock.now(), nonStandard: config.quoteType === 'non-standard' });
    this.writeVersion(id, 1, config, priced, actor);
    this.transition(id, 1, 'created', actor, { quoteType: config.quoteType });
    return this.getQuote(id);
  }

  /**
   * Edit = new version. Cosmetic-only edits (cover fields) keep the pinned
   * rule set and price book; any other edit prices under the current rules.
   * If the approval fingerprint is unchanged, an APPROVED quote stays APPROVED.
   */
  editQuote(actor: string, quoteId: string, patch: Partial<QuoteConfig>): QuoteView {
    const q = this.mustQuote(quoteId);
    this.requireOwnerOrDesk(actor, q);
    if (TERMINAL.has(q.state) || q.state === 'SENT' || q.state === 'VIEWED' || q.state === 'SIGNED')
      throw conflict(`quote is ${q.state}; ${q.state === 'SENT' || q.state === 'VIEWED' ? 'recall it first' : 'clone it to make changes'}`);
    const cur = this.mustVersion(quoteId);
    const merged = this.normalizeConfig({ ...cur.config, ...patch, accountId: cur.config.accountId, quoteType: cur.config.quoteType });
    const cosmeticOnly = hashJson({ ...merged, cover: null }) === hashJson({ ...cur.config, cover: null });
    const rs = cosmeticOnly ? this.rules.byVersion(cur.ruleSetVersion) : this.rules.current();
    const pb = this.priceBook(cosmeticOnly ? cur.priceBookVersion : undefined);
    const priced = this.price(merged, rs, pb);
    const next = this.writeVersion(quoteId, cur.version + 1, merged, priced, actor);
    const material = next.approvalFingerprint !== cur.approvalFingerprint;
    this.transition(quoteId, next.version, 'edited', actor, { material, cosmeticOnly, fromVersion: cur.version });
    return this.getQuote(quoteId);
  }

  /** Repricing is an explicit act that creates a NEW version under the current rules. */
  reprice(actor: string, quoteId: string): QuoteView {
    const q = this.mustQuote(quoteId);
    this.requireOwnerOrDesk(actor, q);
    const cur = this.mustVersion(quoteId);
    const rs = this.rules.current();
    const priced = this.price(cur.config, rs, this.priceBook());
    const next = this.writeVersion(quoteId, cur.version + 1, cur.config, priced, actor);
    this.transition(quoteId, next.version, 'repriced', actor, {
      material: next.approvalFingerprint !== cur.approvalFingerprint,
      fromRuleSet: cur.ruleSetVersion,
      toRuleSet: rs.version,
    });
    return this.getQuote(quoteId);
  }

  /** A terminal quote can't be edited; clone it into a fresh draft. */
  cloneQuote(actor: string, quoteId: string): QuoteView {
    const src = this.mustVersion(quoteId);
    const { asOf: _a, startDate: _s, ...rest } = src.config;
    const v = this.createQuote(actor, rest);
    this.transition(v.quote.id, 1, 'cloned-from', actor, { sourceQuoteId: quoteId, sourceVersion: src.version });
    return this.getQuote(v.quote.id);
  }

  // ───────────────────────── approvals ─────────────────────────

  submit(actor: string, quoteId: string, repNote = ''): ApprovalProgress {
    const q = this.mustQuote(quoteId);
    this.requireOwnerOrDesk(actor, q);
    const v = this.mustVersion(quoteId);
    const priced = deserialize<PricedQuote>(v.materialized);
    if (priced.quoteType === 'non-standard' && !repNote.trim() && !v.config.nonStandardReason) throw invalid('non-standard quotes need a reason');
    let plan: ApprovalPlan;
    try {
      // The plan uses the rule set the quote was priced under, and is stored:
      // if approval rules change mid-flight, this approval follows the plan it started with.
      plan = resolvePlan(priced, v.config, this.rules.byVersion(v.ruleSetVersion), q.ownerId, { users: this.store.users() });
    } catch (e) {
      if (e instanceof ApprovalResolutionError) throw invalid(`approval chain cannot be resolved: ${e.message}`);
      throw e;
    }
    this.transition(quoteId, v.version, 'submitted', actor, { repNote, stages: plan.stages.length });
    const rec: PlanRecord = { id: `plan-${this.store.nextId('plan')}`, quoteId, quoteVersion: v.version, plan, submittedAt: this.clock.now(), submittedBy: actor, repNote };
    this.store.insertPlan(rec);
    const progress = this.progress(quoteId);
    if (progress.activeStage === null) {
      this.transition(quoteId, v.version, plan.stages.length === 0 ? 'auto-approved' : 'approved', 'system', {
        planId: rec.id,
        carriedOver: plan.stages.length > 0,
      });
    }
    return this.progress(quoteId);
  }

  private slotKey(s: ApprovalSlot): string {
    return `${s.ruleId}|${s.eligibleUserIds.join(',')}`;
  }

  /** Current plan progress. Approvals count if their fingerprint equals the plan's. */
  progress(quoteId: string): ApprovalProgress {
    const plans = this.store.plans(quoteId);
    const plan = plans.at(-1) ?? null;
    const v = this.mustVersion(quoteId);
    if (!plan) return { plan: null, fingerprintCurrent: true, activeStage: null, stages: [] };
    const approvals = this.store.approvals(quoteId);
    const escalations = this.store.events(quoteId).filter((e) => e.type === 'escalated' && e.payload.planId === plan.id);
    let active: number | null = null;
    let rejected = false;
    const stages: ApprovalProgress['stages'] = plan.plan.stages.map((st) => {
      const slots = st.slots.map((s) => {
        const key = this.slotKey(s);
        // decisions made against this exact fingerprint, from this plan or (approvals only) an earlier plan
        const ds = approvals
          .filter((a) => a.slotKey === key && a.fingerprint === plan.plan.fingerprint)
          .filter((a) => a.planId === plan.id || a.decision !== 'rejected')
          .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
        const last = ds.at(-1);
        return {
          ...s,
          slotKey: key,
          status: (last ? last.decision : 'pending') as 'approved' | 'conditional' | 'rejected' | 'pending',
          decidedBy: last?.approverId ?? null,
          onBehalfOf: last?.onBehalfOf ?? null,
          conditions: last?.conditions ?? null,
          escalatedTo: escalations.filter((e) => e.payload.slotKey === key).flatMap((e) => e.payload.addedUserIds as string[]),
        };
      });
      const anyRejected = slots.some((s) => s.status === 'rejected');
      const done = slots.every((s) => s.status === 'approved' || s.status === 'conditional');
      let status: 'done' | 'active' | 'waiting' | 'rejected';
      if (anyRejected) {
        status = 'rejected';
        rejected = true;
      } else if (done) status = 'done';
      else if (active === null && !rejected) {
        status = 'active';
        active = st.index;
      } else status = 'waiting';
      return { index: st.index, status, slots };
    });
    return { plan, fingerprintCurrent: plan.plan.fingerprint === v.approvalFingerprint, activeStage: rejected ? null : active, stages };
  }

  private eligibleVia(actor: string, slot: ApprovalProgress['stages'][number]['slots'][number], at: string): { ok: boolean; onBehalfOf: string | null } {
    if (slot.eligibleUserIds.includes(actor) || slot.escalatedTo.includes(actor)) return { ok: true, onBehalfOf: null };
    const d = this.store
      .delegations()
      .find((x) => x.toUserId === actor && [...slot.eligibleUserIds, ...slot.escalatedTo].includes(x.fromUserId) && x.from <= at && at < x.until);
    return d ? { ok: true, onBehalfOf: d.fromUserId } : { ok: false, onBehalfOf: null };
  }

  decide(
    actor: string,
    quoteId: string,
    slotId: string,
    decision: 'approved' | 'rejected' | 'conditional',
    opts: { conditions?: string; comment?: string } = {},
  ): ApprovalProgress {
    const q = this.mustQuote(quoteId);
    if (q.state !== 'PENDING_APPROVAL') throw conflict(`quote is ${q.state}, not pending approval`);
    if (actor === q.ownerId) throw forbidden('a quote owner cannot approve their own quote');
    const v = this.mustVersion(quoteId);
    const prog = this.progress(quoteId);
    if (!prog.plan) throw conflict('no approval plan');
    if (!prog.fingerprintCurrent) throw conflict('quote changed since submission; it must be resubmitted');
    if (prog.activeStage === null) throw conflict('no approval stage is active');
    const stage = prog.stages[prog.activeStage]!;
    const slot = stage.slots.find((s) => s.slotId === slotId);
    if (!slot) {
      const waiting = prog.stages.some((st) => st.slots.some((s) => s.slotId === slotId));
      throw conflict(waiting ? `slot ${slotId} is not active yet (sequential chain)` : `unknown slot ${slotId}`);
    }
    if (slot.status !== 'pending') throw conflict(`slot ${slotId} already decided`);
    const now = this.clock.now();
    const via = this.eligibleVia(actor, slot, now);
    if (!via.ok) throw forbidden(`${actor} is not an eligible approver for "${slot.label}"`);
    if (decision === 'conditional' && !opts.conditions?.trim()) throw invalid('conditional approval needs the conditions');
    if (decision === 'rejected' && !opts.comment?.trim()) throw invalid('a rejection needs a reason');
    const rec: ApprovalRecord = {
      id: `appr-${this.store.nextId('approval')}`,
      quoteId,
      quoteVersion: v.version,
      planId: prog.plan.id,
      slotId,
      slotKey: slot.slotKey,
      approverId: actor,
      onBehalfOf: via.onBehalfOf,
      role: slot.role,
      fingerprint: v.approvalFingerprint, // ★ what they actually approved
      decision,
      conditions: opts.conditions ?? null,
      comment: opts.comment ?? null,
      decidedAt: now,
    };
    this.store.insertApproval(rec);
    this.transition(quoteId, v.version, 'approval-decided', actor, { slotId, decision, onBehalfOf: via.onBehalfOf, conditions: rec.conditions });
    if (decision === 'rejected') this.transition(quoteId, v.version, 'rejected', actor, { slotId, reason: opts.comment ?? '' });
    else {
      const after = this.progress(quoteId);
      if (after.activeStage === null && after.stages.every((s) => s.status === 'done'))
        this.transition(quoteId, v.version, 'approved', 'system', { planId: prog.plan.id });
    }
    return this.progress(quoteId);
  }

  delegate(actor: string, toUserId: string, until: string, reason = ''): void {
    this.user(actor);
    this.user(toUserId);
    if (actor === toUserId) throw invalid('cannot delegate to yourself');
    const now = this.clock.now();
    if (!(until > now)) throw invalid('delegation must end in the future');
    this.store.insertDelegation({ id: `dlg-${this.store.nextId('delegation')}`, fromUserId: actor, toUserId, from: now, until, createdAt: now, reason });
  }

  /** Escalate slots waiting longer than N business hours to the eligible approvers' managers. */
  runEscalations(): Array<{ quoteId: string; slotId: string; addedUserIds: string[] }> {
    const out: Array<{ quoteId: string; slotId: string; addedUserIds: string[] }> = [];
    const now = this.clock.now();
    for (const q of this.store.quotes().filter((x) => x.state === 'PENDING_APPROVAL')) {
      const prog = this.progress(q.id);
      if (!prog.plan || prog.activeStage === null) continue;
      const rs = this.rules.byVersion(this.mustVersion(q.id).ruleSetVersion);
      // the active stage became active when the previous stage's last decision landed (or at submission)
      const prevKeys = new Set(prog.stages.slice(0, prog.activeStage).flatMap((s) => s.slots.map((x) => x.slotKey)));
      const activatedAt = this.store
        .approvals(q.id)
        .filter((a) => prevKeys.has(a.slotKey) && a.fingerprint === prog.plan!.plan.fingerprint)
        .map((a) => a.decidedAt)
        .reduce((m, t) => (t > m ? t : m), prog.plan.submittedAt);
      if (!escalationDue(activatedAt, now, rs.escalation.afterBusinessHours, this.calendar)) continue;
      for (const slot of prog.stages[prog.activeStage]!.slots) {
        if (slot.status !== 'pending' || slot.escalatedTo.length) continue;
        const users = this.store.users();
        const managers = [...new Set(slot.eligibleUserIds.map((id) => users.find((u) => u.id === id)?.managerId).filter((m): m is string => !!m && m !== q.ownerId))].sort();
        if (!managers.length) continue;
        this.transition(q.id, prog.plan.quoteVersion, 'escalated', 'system', { planId: prog.plan.id, slotId: slot.slotId, slotKey: slot.slotKey, addedUserIds: managers });
        out.push({ quoteId: q.id, slotId: slot.slotId, addedUserIds: managers });
      }
    }
    return out;
  }

  /** Approval requests that a user can act on right now, with context. */
  inbox(userId: string): Array<{ quoteId: string; number: number; account: string; slotId: string; label: string; reason: string; summary: string; repNote: string; total: string; viaDelegation: string | null }> {
    const out: ReturnType<QuoteService['inbox']> = [];
    const now = this.clock.now();
    for (const q of this.store.quotes().filter((x) => x.state === 'PENDING_APPROVAL')) {
      if (q.ownerId === userId) continue;
      const prog = this.progress(q.id);
      if (!prog.plan || prog.activeStage === null) continue;
      for (const s of prog.stages[prog.activeStage]!.slots) {
        if (s.status !== 'pending') continue;
        const via = this.eligibleVia(userId, s, now);
        if (!via.ok) continue;
        const p = this.getQuote(q.id).priced;
        out.push({
          quoteId: q.id,
          number: q.number,
          account: this.store.account(q.accountId)?.name ?? q.accountId,
          slotId: s.slotId,
          label: s.ruleName,
          reason: s.reason,
          summary: prog.plan.plan.summary,
          repNote: prog.plan.repNote,
          total: renderMoney(p.total),
          viaDelegation: via.onBehalfOf,
        });
      }
    }
    return out;
  }

  recall(actor: string, quoteId: string, reason = 'recalled by rep'): Promise<void> {
    return this.recallAsync(actor, quoteId, reason);
  }
  private async recallAsync(actor: string, quoteId: string, reason: string): Promise<void> {
    const q = this.mustQuote(quoteId);
    this.requireOwnerOrDesk(actor, q);
    if (q.state === 'SENT' || q.state === 'VIEWED') {
      // Superseding a sent version: void it proactively so the customer can't sign a stale version (§10.5).
      for (const env of this.store.envelopes(quoteId).filter((e) => !ENVELOPE_TERMINAL.has(e.state) && e.providerId)) {
        // Mark locally first so the provider's own "voided" webhook is recognised as ours and ignored.
        this.store.updateEnvelope(env.id, { state: 'voided' });
        try {
          await this.provider.void(env.providerId!, reason);
        } catch (e) {
          this.store.updateEnvelope(env.id, { state: env.state });
          throw e;
        }
        this.store.appendEnvelopeEvent({ envelopeId: env.id, source: 'local', from: env.state, to: 'voided', eventId: `local-void-${env.id}`, at: this.clock.now(), drift: false });
      }
    }
    this.transition(quoteId, this.mustVersion(quoteId).version, 'recalled', actor, { reason });
  }

  // ───────────────────────── documents ─────────────────────────

  async generateDocument(quoteId: string, version?: number): Promise<{ record: DocumentRecord; bytes: Uint8Array }> {
    const q = this.mustQuote(quoteId);
    const v = this.mustVersion(quoteId, version);
    const acct = this.store.account(q.accountId);
    if (!acct) throw notFound(`account ${q.accountId}`);
    // Re-rendering a version uses the template it was first rendered with (templates are versioned too).
    const prior = this.store.documents(quoteId).find((d) => d.quoteVersion === v.version);
    const tpl = prior ? this.store.template(prior.templateVersion) : this.store.latestTemplate();
    if (!tpl) throw notFound('template');
    const conditions = this.store
      .approvals(quoteId)
      .filter((a) => a.decision === 'conditional' && a.fingerprint === v.approvalFingerprint && a.conditions)
      .map((a) => a.conditions!)
      .sort();
    const model = buildRenderModel({
      priced: deserialize<PricedQuote>(v.materialized),
      config: v.config,
      account: acct,
      template: tpl,
      quoteNumber: q.number,
      quoteVersion: v.version,
      pricedAt: v.pricedAt,
      approvalConditions: conditions,
    });
    const gen = await generateProposalPdf(model);
    const existing = this.store.documents(quoteId).find((d) => d.quoteVersion === v.version && d.sha256 === gen.sha256);
    if (existing) return { record: existing, bytes: gen.bytes };
    const key = `docs/${quoteId}/v${v.version}/${gen.sha256}.pdf`;
    this.store.putBlob(key, gen.bytes);
    const record: DocumentRecord = {
      id: `doc-${this.store.nextId('document')}`,
      quoteId,
      quoteVersion: v.version,
      templateVersion: gen.templateVersion,
      sha256: gen.sha256,
      contentHash: gen.contentHash,
      storageKey: key,
      generatedAt: this.clock.now(),
    };
    this.store.insertDocument(record);
    if (canApply(q.state, { type: 'document-generated', payload: {} }))
      this.transition(quoteId, v.version, 'document-generated', 'system', { documentId: record.id, sha256: gen.sha256, pages: gen.pageCount });
    return { record, bytes: gen.bytes };
  }

  // ───────────────────────── send & e-signature ─────────────────────────

  /**
   * Send for signature. Refuses — naming who must re-approve — if the quote's
   * material terms changed since approval. Idempotent: a retry never creates
   * a second envelope.
   */
  async send(actor: string, quoteId: string): Promise<EnvelopeRecord> {
    const q = this.mustQuote(quoteId);
    this.requireOwnerOrDesk(actor, q);
    const v = this.mustVersion(quoteId);
    const current = approvalFingerprint(deserialize<PricedQuote>(v.materialized));
    if (current !== v.approvalFingerprint) throw conflict('stored fingerprint does not match materialized quote — data integrity failure');

    const approvals = this.store.approvals(quoteId).filter((a) => a.decision !== 'rejected');
    const plan = this.store.plans(quoteId).at(-1);
    if (plan && plan.plan.fingerprint !== current) {
      const names = [...new Set(approvals.filter((a) => a.fingerprint === plan.plan.fingerprint).map((a) => this.store.user(a.approverId)?.name ?? a.approverId))];
      const who = names.length ? names : [...new Set(plan.plan.stages.flatMap((s) => s.slots.map((x) => x.label)))];
      throw new ApprovalInvalidatedError(who, `Quote changed since approval. Re-approval required from: ${who.join(', ')}`);
    }
    // Idempotent retry of a send that already went out for this version.
    const already = this.store.envelopes(quoteId).find((e) => e.quoteVersion === v.version && e.providerId && e.state !== 'voided');
    if (already && q.state !== 'APPROVED') return already;
    if (q.state !== 'APPROVED') throw conflict(`quote is ${q.state}; it must be APPROVED to send`);
    if (plan) {
      const prog = this.progress(quoteId);
      const missing = prog.stages.flatMap((s) => s.slots).filter((s) => s.status !== 'approved' && s.status !== 'conditional');
      if (missing.length) throw new ApprovalInvalidatedError(missing.map((m) => m.label), `Approvals missing for: ${missing.map((m) => m.label).join(', ')}`);
    }

    const { record: doc, bytes } = await this.generateDocument(quoteId, v.version);
    const idempotencyKey = sha256(`${quoteId}:${v.version}:${doc.sha256}`);
    const acct = this.store.account(q.accountId)!;

    let env = this.store.envelopeByKey(idempotencyKey);
    if (env && env.providerId) return env; // already sent: never send twice
    if (!env) {
      // Store the key BEFORE calling the provider so a crash in between is recoverable.
      env = {
        id: `env-${this.store.nextId('envelope')}`,
        quoteId,
        quoteVersion: v.version,
        documentId: doc.id,
        provider: this.provider.name,
        providerId: null,
        idempotencyKey,
        state: 'creating',
        recipients: [{ id: '1', name: acct.signer.name, email: acct.signer.email, status: 'created' }],
        createdAt: this.clock.now(),
        sentAt: null,
        completedAt: null,
        appliedEventIds: [],
        declineReason: null,
      };
      this.store.insertEnvelope(env);
    } else {
      // A previous attempt crashed after storing the key: ask the provider before sending again.
      const found = await this.provider.findByIdempotencyKey(idempotencyKey);
      if (found) return this.markSent(env, found.providerId, found.state);
    }
    const ref = await this.provider.createEnvelope(
      {
        documentBytes: bytes,
        documentName: `Q-${q.number}-v${v.version}.pdf`,
        emailSubject: `Please sign: proposal Q-${q.number} for ${acct.name}`,
        signers: [{ recipientId: '1', name: acct.signer.name, email: acct.signer.email }],
        anchors: ANCHORS,
        metadata: { quoteId, quoteVersion: v.version, contentHash: doc.contentHash },
        expiresInDays: 30,
      },
      idempotencyKey,
    );
    return this.markSent(env, ref.providerId, ref.state);
  }

  private async markSent(env: EnvelopeRecord, providerId: string, state: ProviderEnvelopeState): Promise<EnvelopeRecord> {
    const updated = this.store.updateEnvelope(env.id, { providerId, state: 'sent', sentAt: this.clock.now() });
    this.store.appendEnvelopeEvent({ envelopeId: env.id, source: 'local', from: env.state, to: 'sent', eventId: `local-sent-${env.id}`, at: this.clock.now(), drift: false });
    const q = this.mustQuote(env.quoteId);
    if (q.state === 'APPROVED') this.transition(env.quoteId, env.quoteVersion, 'sent', 'system', { envelopeId: env.id, providerId });
    // If the provider already moved on (recovery case), catch up.
    if (state !== 'sent') await this.applyEnvelopeEvent({ eventId: `recover:${providerId}:${state}`, providerId, state, recipients: [], declineReason: null, occurredAt: this.clock.now() }, 'reconcile');
    return updated;
  }

  /** Webhook fast path: verify (HMAC + replay window), then apply idempotently. */
  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ applied: boolean }> {
    const ev = this.provider.verifyWebhook(headers, rawBody, this.clock.now());
    return { applied: await this.applyEnvelopeEvent(ev, 'webhook') };
  }

  /**
   * Apply a provider state change. Idempotent: the webhook and the poller
   * frequently deliver the same transition; duplicates and regressions are no-ops.
   */
  async applyEnvelopeEvent(ev: WebhookEvent, source: 'webhook' | 'reconcile'): Promise<boolean> {
    const env = this.store.envelopeByProviderId(ev.providerId);
    if (!env) {
      this.log('envelope event for unknown envelope', ev);
      return false;
    }
    if (env.appliedEventIds.includes(ev.eventId)) return false;
    if (!isForward(env.state, ev.state)) {
      this.store.updateEnvelope(env.id, { appliedEventIds: [...env.appliedEventIds, ev.eventId], ...(ev.recipients.length ? { recipients: mergeRecipients(env, ev) } : {}) });
      return false;
    }
    const drift = source === 'reconcile';
    if (drift) this.log('envelope drift detected — webhook likely missed', { envelopeId: env.id, local: env.state, remote: ev.state });
    const patch: Partial<EnvelopeRecord> = { state: ev.state, appliedEventIds: [...env.appliedEventIds, ev.eventId] };
    if (ev.recipients.length) patch.recipients = mergeRecipients(env, ev);
    if (ev.declineReason) patch.declineReason = ev.declineReason;
    this.store.updateEnvelope(env.id, patch);
    this.store.appendEnvelopeEvent({ envelopeId: env.id, source, from: env.state, to: ev.state, eventId: ev.eventId, at: this.clock.now(), drift });

    const q = this.mustQuote(env.quoteId);
    const apply = (type: QuoteEventType, payload: Record<string, unknown>) => {
      if (canApply(q.state, { type, payload })) this.transition(env.quoteId, env.quoteVersion, type, 'esign', { envelopeId: env.id, source, ...payload });
      else this.log(`envelope ${env.id} ${ev.state}: quote is ${q.state}, no transition`);
    };
    switch (ev.state) {
      case 'delivered':
        apply('viewed', {});
        break;
      case 'declined':
        apply('declined', { reason: ev.declineReason ?? '' });
        break;
      case 'voided':
        apply('voided', {});
        break;
      case 'expired':
        apply('expired', {});
        break;
      case 'completed':
        await this.onCompleted(env.id);
        break;
      case 'sent':
        break;
    }
    return true;
  }

  /** Verify the signed document is ours, store it + the certificate, emit the contract. */
  private async onCompleted(envelopeId: string): Promise<void> {
    const env = this.store.envelope(envelopeId)!;
    const doc = this.store.document(env.documentId)!;
    const { bytes, certificate } = await this.provider.downloadCompleted(env.providerId!);
    const embedded = await extractContentHash(bytes);
    if (embedded !== doc.contentHash) {
      this.store.updateEnvelope(env.id, { state: 'mismatch' });
      this.store.flag({ kind: 'signature-mismatch', ref: env.id, message: 'signed document does not match generated document', at: this.clock.now() });
      const q = this.mustQuote(env.quoteId);
      if (canApply(q.state, { type: 'signature-mismatch', payload: {} }))
        this.transition(env.quoteId, env.quoteVersion, 'signature-mismatch', 'esign', { envelopeId, expected: doc.contentHash, found: embedded });
      return;
    }
    const q = this.mustQuote(env.quoteId);
    const v = this.mustVersion(env.quoteId, env.quoteVersion);
    // The customer signed a version that has since been superseded internally: v is binding (§10.5), recorded explicitly.
    const latest = this.mustVersion(env.quoteId);
    const signedKey = `executed/${env.quoteId}/v${v.version}/signed.pdf`;
    const certKey = `executed/${env.quoteId}/v${v.version}/certificate.json`;
    this.store.putBlob(signedKey, bytes);
    this.store.putBlob(certKey, certificate); // kept permanently: ESIGN / eIDAS evidence
    const now = this.clock.now();
    this.store.updateEnvelope(env.id, { completedAt: now });
    this.transition(env.quoteId, v.version, 'signed', 'esign', { envelopeId, signedSha256: sha256(bytes), supersededBy: latest.version !== v.version ? latest.version : null });

    const acct = this.store.account(q.accountId)!;
    const contract = buildExecutedContract({
      contractId: `ctr-${q.number}-v${v.version}`,
      quoteId: q.id,
      quoteNumber: q.number,
      quoteVersion: v.version,
      documentHash: doc.sha256,
      contentHash: doc.contentHash,
      executedAt: now,
      priced: deserialize<PricedQuote>(v.materialized),
      config: v.config,
      account: acct,
      approvals: this.store
        .approvals(q.id)
        .filter((a) => a.fingerprint === v.approvalFingerprint && a.decision !== 'rejected')
        .map((a) => ({ approverId: a.approverId, role: a.role, decision: a.decision, conditions: a.conditions, decidedAt: a.decidedAt })),
    });
    if (!this.store.contract(q.id)) this.store.insertContract({ contract, signedDocKey: signedKey, certificateKey: certKey, storedAt: now });
    this.publish('contract.executed', `contract-executed:${contract.contractId}`, { contract });
    this.transition(q.id, v.version, 'closed-won', 'system', { contractId: contract.contractId });
  }

  private publish(topic: string, key: string, payload: unknown): void {
    if (!this.store.appendOutbox(topic, key, payload, this.clock.now())) return; // redelivery-safe
    for (const l of this.listeners) l(topic, payload);
  }

  /**
   * Polling safety net: webhooks get dropped. Every open envelope older than
   * `olderThanMinutes` is checked against the provider; drift is logged.
   */
  async reconcile(olderThanMinutes = 10): Promise<{ checked: number; drifted: Array<{ envelopeId: string; local: string; remote: string }>; recovered: string[] }> {
    const cutoff = Date.parse(this.clock.now()) - olderThanMinutes * 60_000;
    const open = this.store.envelopes().filter((e) => !ENVELOPE_TERMINAL.has(e.state) && Date.parse(e.createdAt) <= cutoff);
    const drifted: Array<{ envelopeId: string; local: string; remote: string }> = [];
    const recovered: string[] = [];
    for (const env of open) {
      if (env.state === 'creating' || !env.providerId) {
        const found = await this.provider.findByIdempotencyKey(env.idempotencyKey);
        if (found) {
          await this.markSent(env, found.providerId, found.state);
          recovered.push(env.id);
        }
        continue;
      }
      let status;
      try {
        status = await this.provider.getEnvelope(env.providerId);
      } catch (e) {
        this.log('reconcile: provider lookup failed', { envelopeId: env.id, error: (e as Error).message });
        continue;
      }
      if (status.state !== env.state) {
        drifted.push({ envelopeId: env.id, local: env.state, remote: status.state });
        await this.applyEnvelopeEvent(
          { eventId: `reconcile:${env.providerId}:${status.state}`, providerId: env.providerId, state: status.state, recipients: status.recipients, declineReason: status.declineReason, occurredAt: status.updatedAt },
          'reconcile',
        );
      }
    }
    return { checked: open.length, drifted, recovered };
  }

  // ───────────────────────── governance & audit ─────────────────────────

  /** Replay every historical quote version under its pinned rule set and price book. */
  replayAll(): Array<{ quoteId: string; version: number; ok: boolean; error?: string }> {
    return this.store.quoteVersions().map((qv) => {
      try {
        const replayed = this.engine(qv.config, this.rules.byVersion(qv.ruleSetVersion), this.priceBook(qv.priceBookVersion));
        const ok = serialize(replayed) === qv.materialized;
        return ok ? { quoteId: qv.quoteId, version: qv.version, ok } : { quoteId: qv.quoteId, version: qv.version, ok, error: 'no longer reproduces' };
      } catch (e) {
        return { quoteId: qv.quoteId, version: qv.version, ok: false, error: (e as Error).message };
      }
    });
  }

  /** quotes.state must equal the fold of the event log. */
  consistencyCheck(): Array<{ quoteId: string; stored: QuoteState; derived: QuoteState }> {
    return this.store
      .quotes()
      .map((q) => ({ quoteId: q.id, stored: q.state, derived: fold(this.store.events(q.id)) }))
      .filter((x) => x.stored !== x.derived);
  }

  /** Frequency of sanctioned non-standard deals — where the rule model is inadequate (§12.4). */
  nonStandardReport(): { total: number; nonStandard: number; rateBp: number; byMonth: Array<{ month: string; total: number; nonStandard: number }>; deals: Array<{ quoteId: string; number: number; reason: string; state: string; total: string }> } {
    const quotes = this.store.quotes();
    const months = new Map<string, { total: number; nonStandard: number }>();
    for (const q of quotes) {
      const m = q.createdAt.slice(0, 7);
      const r = months.get(m) ?? { total: 0, nonStandard: 0 };
      r.total++;
      if (q.nonStandard) r.nonStandard++;
      months.set(m, r);
    }
    const ns = quotes.filter((q) => q.nonStandard);
    return {
      total: quotes.length,
      nonStandard: ns.length,
      rateBp: quotes.length ? Math.round((ns.length * 10_000) / quotes.length) : 0,
      byMonth: [...months.entries()].sort().map(([month, r]) => ({ month, ...r })),
      deals: ns.map((q) => {
        const v = this.mustVersion(q.id);
        return { quoteId: q.id, number: q.number, reason: v.config.nonStandardReason ?? '', state: q.state, total: renderMoney(deserialize<PricedQuote>(v.materialized).total) };
      }),
    };
  }

  auditExport(quoteId: string): Record<string, unknown> {
    const q = this.mustQuote(quoteId);
    return {
      exportedAt: this.clock.now(),
      quote: q,
      versions: this.store.quoteVersions(quoteId).map((v) => ({ ...v, materialized: JSON.parse(v.materialized) as unknown })),
      events: this.store.events(quoteId),
      plans: this.store.plans(quoteId),
      approvals: this.store.approvals(quoteId),
      documents: this.store.documents(quoteId),
      envelopes: this.store.envelopes(quoteId),
      envelopeEvents: this.store.envelopes(quoteId).flatMap((e) => this.store.envelopeEvents(e.id)),
      contract: this.store.contract(quoteId)?.contract ?? null,
      stateConsistent: fold(this.store.events(quoteId)) === q.state,
    };
  }

  contract(quoteId: string): ExecutedContract {
    const c = this.store.contract(quoteId);
    if (!c) throw notFound(`executed contract for ${quoteId}`);
    return c.contract;
  }
}

function mergeRecipients(env: EnvelopeRecord, ev: WebhookEvent): EnvelopeRecord['recipients'] {
  return env.recipients.map((r) => ({ ...r, status: ev.recipients.find((x) => x.recipientId === r.id)?.status ?? r.status }));
}

const renderMoney = format;
