/**
 * Rule governance (design guide §12): rules are data with a named owner,
 * edited without a deploy, but every change goes
 *   DRAFT → SIMULATED → PENDING_APPROVAL → PUBLISHED (immutable)
 * with mandatory simulation and approval by a pricing owner who is not the author.
 */
import type { Store, RuleDraft, RuleSetRecord } from '../store/store.ts';
import type { RuleSet, RuleSetDefinition } from '../pricing/types.ts';
import { hashJson } from '../util/hash.ts';
import { validateRuleSet, type ValidationResult } from '../rules/validate.ts';
import { simulate, type SimulationReport } from '../rules/simulate.ts';
import { diff, type DiffEntry } from '../rules/diff.ts';
import type { Clock } from './errors.ts';
import { conflict, forbidden, invalid, notFound } from './errors.ts';

export const RULE_AUTHOR_ROLES = ['pricing-analyst', 'pricing-owner'];
export const RULE_APPROVER_ROLE = 'pricing-owner';
/** Draft effective date meaning "when approved". */
export const ON_PUBLISH = 'on-publish';

export function toRuleSet(r: RuleSetRecord): RuleSet {
  return { ...structuredClone(r.definition), version: r.version, effectiveFrom: r.effectiveFrom };
}

export function ruleSetContentHash(def: RuleSetDefinition, effectiveFrom: string): string {
  return hashJson({ definition: def, effectiveFrom });
}

export class RuleService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  private roles(userId: string): string[] {
    return this.store.user(userId)?.roles ?? [];
  }
  private requireAuthor(userId: string): void {
    if (!this.roles(userId).some((r) => RULE_AUTHOR_ROLES.includes(r))) throw forbidden(`${userId} cannot author pricing rules`);
  }

  /** The rule set in force at an instant: the highest version whose effectiveFrom ≤ at. */
  current(at: string = this.clock.now()): RuleSet {
    const r = this.store
      .ruleSets()
      .filter((x) => x.effectiveFrom <= at)
      .sort((a, b) => b.version - a.version)[0];
    if (!r) throw notFound('an effective rule set');
    return toRuleSet(r);
  }

  byVersion(v: number): RuleSet {
    const r = this.store.ruleSet(v);
    if (!r) throw notFound(`rule set v${v}`);
    return toRuleSet(r);
  }

  list(): Array<Omit<RuleSetRecord, 'definition'> & { current: boolean }> {
    const cur = this.current().version;
    return this.store.ruleSets().map(({ definition: _d, ...rest }) => ({ ...rest, current: rest.version === cur }));
  }

  validate(def: RuleSetDefinition): ValidationResult {
    const users = this.store.users();
    return validateRuleSet(def, {
      priceBook: this.store.latestPriceBook(),
      roles: new Set(users.flatMap((u) => u.roles)),
      userIds: new Set(users.map((u) => u.id)),
    });
  }

  createDraft(actor: string, input: { title: string; basedOnVersion?: number; definition?: RuleSetDefinition; effectiveFrom?: string }): RuleDraft {
    this.requireAuthor(actor);
    const base = input.basedOnVersion !== undefined ? this.byVersion(input.basedOnVersion) : this.current();
    const { version, effectiveFrom: _e, ...baseDef } = base;
    const now = this.clock.now();
    const d: RuleDraft = {
      id: `draft-${this.store.nextId('draft')}`,
      title: input.title || `Changes to v${version}`,
      basedOnVersion: version,
      definition: input.definition ?? baseDef,
      effectiveFrom: input.effectiveFrom ?? ON_PUBLISH,
      author: actor,
      state: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      simulation: null,
      simulatedHash: null,
      publishedVersion: null,
      history: [{ at: now, actor, action: 'created' }],
    };
    this.store.insertDraft(d);
    return d;
  }

  getDraft(id: string): RuleDraft & { validation: ValidationResult; diff: DiffEntry[]; contentHash: string } {
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    const base = this.byVersion(d.basedOnVersion);
    const { version: _v, effectiveFrom: _e, ...baseDef } = base;
    return { ...d, validation: this.validate(d.definition), diff: diff(baseDef, d.definition), contentHash: ruleSetContentHash(d.definition, d.effectiveFrom) };
  }

  listDrafts(): RuleDraft[] {
    return this.store.drafts().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateDraft(actor: string, id: string, patch: { title?: string; definition?: RuleSetDefinition; effectiveFrom?: string }): RuleDraft {
    this.requireAuthor(actor);
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    if (d.state === 'PUBLISHED' || d.state === 'PENDING_APPROVAL') throw conflict(`draft is ${d.state}; recall or reject it before editing`);
    const now = this.clock.now();
    const next: RuleDraft = {
      ...d,
      title: patch.title ?? d.title,
      definition: patch.definition ?? d.definition,
      effectiveFrom: patch.effectiveFrom ?? d.effectiveFrom,
      state: 'DRAFT', // any edit invalidates the simulation
      simulation: null,
      simulatedHash: null,
      updatedAt: now,
      history: [...d.history, { at: now, actor, action: 'edited' }],
    };
    this.store.saveDraft(next);
    return next;
  }

  simulateDraft(actor: string, id: string, sampleSize = 200): SimulationReport {
    this.requireAuthor(actor);
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    if (d.state === 'PUBLISHED') throw conflict('draft already published');
    const v = this.validate(d.definition);
    if (v.errors.length) throw invalid('rule set does not validate', v.errors);
    const hash = ruleSetContentHash(d.definition, d.effectiveFrom);
    const nextVersion = Math.max(0, ...this.store.ruleSets().map((r) => r.version)) + 1;
    const proposed: RuleSet = { ...d.definition, version: nextVersion, effectiveFrom: d.effectiveFrom === ON_PUBLISH ? this.clock.now() : d.effectiveFrom };
    const now = this.clock.now();
    const quotes = new Map(this.store.quotes().map((q) => [q.id, q]));
    const latest = new Map<string, ReturnType<Store['quoteVersions']>[number]>();
    for (const qv of this.store.quoteVersions()) latest.set(qv.quoteId, qv);
    const sample = [...latest.values()]
      .sort((a, b) => b.pricedAt.localeCompare(a.pricedAt) || a.quoteId.localeCompare(b.quoteId))
      .slice(0, sampleSize)
      .map((qv) => ({ quote: quotes.get(qv.quoteId)!, version: qv, ruleSet: this.byVersion(qv.ruleSetVersion) }));
    const report = simulate({
      proposed,
      proposedHash: hash,
      sample,
      priceBook: (ver) => {
        const pb = this.store.priceBook(ver);
        if (!pb) throw notFound(`price book v${ver}`);
        return pb;
      },
      directory: { users: this.store.users() },
      at: now,
    });
    this.store.saveDraft({
      ...d,
      state: 'SIMULATED',
      simulation: report,
      simulatedHash: hash,
      updatedAt: now,
      history: [...d.history, { at: now, actor, action: 'simulated', note: report.headline }],
    });
    return report;
  }

  submitDraft(actor: string, id: string, note = ''): RuleDraft {
    this.requireAuthor(actor);
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    if (d.state !== 'SIMULATED') throw conflict('simulation is mandatory before submitting for approval');
    if (d.simulatedHash !== ruleSetContentHash(d.definition, d.effectiveFrom)) throw conflict('draft changed since simulation; simulate again');
    const now = this.clock.now();
    const next: RuleDraft = { ...d, state: 'PENDING_APPROVAL', updatedAt: now, history: [...d.history, { at: now, actor, action: 'submitted', note }] };
    this.store.saveDraft(next);
    return next;
  }

  rejectDraft(actor: string, id: string, note: string): RuleDraft {
    if (!this.roles(actor).includes(RULE_APPROVER_ROLE)) throw forbidden(`${actor} is not a pricing owner`);
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    if (d.state !== 'PENDING_APPROVAL') throw conflict(`draft is ${d.state}`);
    const now = this.clock.now();
    const next: RuleDraft = { ...d, state: 'REJECTED', updatedAt: now, history: [...d.history, { at: now, actor, action: 'rejected', note }] };
    this.store.saveDraft(next);
    return next;
  }

  /** Approve and publish as a new immutable version. */
  approveDraft(actor: string, id: string, note = ''): RuleSetRecord {
    if (!this.roles(actor).includes(RULE_APPROVER_ROLE)) throw forbidden(`${actor} is not a pricing owner`);
    const d = this.store.draft(id);
    if (!d) throw notFound(`draft ${id}`);
    if (d.state !== 'PENDING_APPROVAL') throw conflict(`draft is ${d.state}`);
    if (d.author === actor) throw forbidden('the author of a rule change cannot approve it');
    const v = this.validate(d.definition);
    if (v.errors.length) throw invalid('rule set does not validate', v.errors);
    const now = this.clock.now();
    let effectiveFrom = now;
    if (d.effectiveFrom !== ON_PUBLISH) {
      if (!Number.isFinite(Date.parse(d.effectiveFrom))) throw invalid(`effectiveFrom ${d.effectiveFrom} is not a timestamp`);
      // Retroactive rule changes are impossible through the product (design guide §12.3).
      if (Date.parse(d.effectiveFrom) < Date.parse(now)) throw invalid(`effectiveFrom ${d.effectiveFrom} is in the past; rule changes cannot be retroactive`);
      effectiveFrom = new Date(Date.parse(d.effectiveFrom)).toISOString();
    }
    const version = Math.max(0, ...this.store.ruleSets().map((r) => r.version)) + 1;
    const rec: RuleSetRecord = {
      version,
      definition: d.definition,
      contentHash: ruleSetContentHash(d.definition, effectiveFrom),
      effectiveFrom,
      publishedAt: now,
      publishedBy: d.author,
      approvedBy: actor,
      draftId: d.id,
      notes: note || d.title,
    };
    this.store.insertRuleSet(rec);
    this.store.saveDraft({
      ...d,
      state: 'PUBLISHED',
      publishedVersion: version,
      updatedAt: now,
      history: [...d.history, { at: now, actor, action: 'approved-and-published', note: `v${version}` }],
    });
    return rec;
  }

  diffVersions(a: number, b: number): DiffEntry[] {
    const x = this.store.ruleSet(a);
    const y = this.store.ruleSet(b);
    if (!x || !y) throw notFound('rule set');
    return diff({ ...x.definition, effectiveFrom: x.effectiveFrom }, { ...y.definition, effectiveFrom: y.effectiveFrom });
  }
}

