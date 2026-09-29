/**
 * Approval chains (design guide §8): resolution into a stored plan, the
 * approval fingerprint, business-hours escalation.
 */
import { evaluate, type EvalContext } from '../pricing/conditions.ts';
import type { ApprovalRule, ApproverSpec, PricedQuote, QuoteConfig, RuleSet } from '../pricing/types.ts';
import { format, toDecimalString } from '../money/money.ts';
import { hashJson } from '../util/hash.ts';

export type Directory = {
  users: Array<{ id: string; name: string; roles: string[]; managerId?: string }>;
};

/** One approval requirement: satisfied by a decision from any eligible user. */
export type ApprovalSlot = {
  slotId: string;
  ruleId: string;
  ruleName: string;
  reason: string;
  label: string;
  role: string;
  eligibleUserIds: string[];
};

/** Slots within a stage run in parallel; stages run in sequence. */
export type ApprovalStage = { index: number; slots: ApprovalSlot[] };

export type ApprovalPlan = {
  ruleSetVersion: number;
  fingerprint: string;
  stages: ApprovalStage[];
  /** Human context for notifications — "32% discount on $180k, 12 points above policy, because …". */
  summary: string;
};

export function approvalContext(q: PricedQuote, cfg: QuoteConfig): EvalContext {
  return {
    'approval.total': toDecimalString(q.total),
    'approval.totalDiscountBp': q.totalDiscountBasisPoints,
    'approval.maxLineDiscountBp': q.maxLineDiscountBasisPoints,
    'approval.maxManualDiscountBp': Math.max(cfg.orderManualDiscountBp ?? 0, ...q.lines.map((l) => l.manualDiscountBp)),
    'approval.floorClamped': q.floorClamped,
    'approval.nonStandard': q.quoteType === 'non-standard',
    'approval.paymentNetDays': q.paymentTerms.netDays,
    'approval.termMonths': q.termMonths,
    'approval.legalTermsVersion': q.legalTermsVersion,
    'approval.segment': cfg.segment,
  };
}

export class ApprovalResolutionError extends Error {}

function resolveApprover(spec: ApproverSpec, ownerId: string, dir: Directory): { label: string; role: string; ids: string[] } {
  switch (spec.type) {
    case 'role': {
      const ids = dir.users.filter((u) => u.roles.includes(spec.role)).map((u) => u.id).sort();
      if (!ids.length) throw new ApprovalResolutionError(`no users hold role "${spec.role}"`);
      return { label: spec.role, role: spec.role, ids };
    }
    case 'user': {
      if (!dir.users.some((u) => u.id === spec.userId)) throw new ApprovalResolutionError(`unknown user ${spec.userId}`);
      return { label: spec.userId, role: 'named-approver', ids: [spec.userId] };
    }
    case 'manager-of': {
      let cur = spec.userId === 'owner' ? ownerId : spec.userId;
      for (let i = 0; i < spec.levels; i++) {
        const u = dir.users.find((x) => x.id === cur);
        if (!u?.managerId) throw new ApprovalResolutionError(`${cur} has no manager (level ${i + 1})`);
        cur = u.managerId;
      }
      return { label: `manager of ${spec.userId === 'owner' ? 'quote owner' : spec.userId} (+${spec.levels})`, role: 'manager', ids: [cur] };
    }
  }
}

/**
 * Resolve the rules that fire into an ordered plan. Rules sort by (order, id).
 * A sequential rule contributes one stage per approver; a parallel rule
 * contributes one stage with all its approvers. A requirement already met by
 * an identical earlier slot (same eligible set) is not asked twice.
 * Non-standard quotes always add the top-tier chain at the end.
 */
export function resolvePlan(q: PricedQuote, cfg: QuoteConfig, rs: RuleSet, ownerId: string, dir: Directory): ApprovalPlan {
  const ctx = approvalContext(q, cfg);
  const fired: ApprovalRule[] = rs.approvalRules
    .filter((r) => evaluate(r.condition, ctx))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (q.quoteType === 'non-standard') {
    fired.push({
      id: 'non-standard',
      name: 'Non-standard deal',
      condition: { op: 'true' },
      approvers: rs.nonStandardApprovers,
      mode: 'sequential',
      order: Number.MAX_SAFE_INTEGER,
      reason: `Non-standard deal: ${cfg.nonStandardReason ?? ''}`.trim(),
    });
  }

  const stages: ApprovalStage[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const rule of fired) {
    const slots: ApprovalSlot[] = [];
    for (const spec of rule.approvers) {
      const r = resolveApprover(spec, ownerId, dir);
      // The quote owner can never approve their own quote.
      const ids = r.ids.filter((id) => id !== ownerId);
      if (!ids.length) throw new ApprovalResolutionError(`${rule.id}: only eligible approver is the quote owner`);
      const key = ids.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ slotId: `s${++n}`, ruleId: rule.id, ruleName: rule.name, reason: rule.reason, label: r.label, role: r.role, eligibleUserIds: ids });
    }
    if (!slots.length) continue;
    if (rule.mode === 'parallel') stages.push({ index: stages.length, slots });
    else for (const s of slots) stages.push({ index: stages.length, slots: [s] });
  }

  return { ruleSetVersion: rs.version, fingerprint: approvalFingerprint(q), stages, summary: approvalSummary(q, cfg, fired) };
}

function approvalSummary(q: PricedQuote, cfg: QuoteConfig, fired: ApprovalRule[]): string {
  const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
  const parts = [`${pct(q.totalDiscountBasisPoints)} total discount on ${format(q.total)}`];
  if (q.floorClamped) parts.push('a requested discount hit a floor');
  if (fired.length) parts.push(`triggers: ${fired.map((r) => r.reason).join('; ')}`);
  if (cfg.quoteType === 'non-standard') parts.push(`non-standard: ${cfg.nonStandardReason ?? ''}`);
  return parts.join(' — ');
}

/**
 * Hash of exactly the material terms (design guide §8.3). Cosmetic fields —
 * cover title, intro text, formatting — are deliberately excluded, so fixing
 * a typo doesn't void a CFO's approval, but any price or term change does.
 */
export function approvalFingerprint(q: PricedQuote): string {
  const material = {
    quoteType: q.quoteType,
    lines: q.lines
      .map((l) => ({
        lineId: l.lineId,
        productId: l.productId,
        description: q.quoteType === 'non-standard' ? l.description : undefined,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.minor.toString(),
        net: l.net.minor.toString(),
        discountBp: l.totalDiscountBasisPoints,
        termMonths: l.termMonths,
      }))
      .sort((a, b) => a.lineId.localeCompare(b.lineId)),
    total: q.total.minor.toString(),
    currency: q.currency,
    paymentTerms: q.paymentTerms,
    legalTermsVersion: q.legalTermsVersion,
    startDate: q.startDate,
    termMonths: q.termMonths,
  };
  return hashJson(material);
}

// ───────────────────────── Business hours ─────────────────────────

export type BusinessCalendar = {
  /** Fixed offset of the business time zone from UTC, minutes (e.g. −420 for PDT). */
  utcOffsetMinutes: number;
  startHour: number; // inclusive, local
  endHour: number; // exclusive, local
  /** 0 = Sunday … 6 = Saturday */
  workdays: number[];
  /** Local dates YYYY-MM-DD that are not business days. */
  holidays: string[];
};

export const DEFAULT_CALENDAR: BusinessCalendar = {
  utcOffsetMinutes: -420,
  startHour: 9,
  endHour: 17,
  workdays: [1, 2, 3, 4, 5],
  holidays: [],
};

/** Business minutes elapsed between two instants. Pure; minute resolution. */
export function businessMinutesBetween(fromIso: string, toIso: string, cal: BusinessCalendar = DEFAULT_CALENDAR): number {
  const off = cal.utcOffsetMinutes * 60_000;
  let t = Date.parse(fromIso) + off; // shift into "local as UTC"
  const end = Date.parse(toIso) + off;
  if (!(end > t)) return 0;
  let minutes = 0;
  while (t < end) {
    const d = new Date(t);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const nextDay = dayStart + 86_400_000;
    const localDate = d.toISOString().slice(0, 10);
    if (cal.workdays.includes(d.getUTCDay()) && !cal.holidays.includes(localDate)) {
      const open = dayStart + cal.startHour * 3_600_000;
      const close = dayStart + cal.endHour * 3_600_000;
      const a = Math.max(t, open);
      const b = Math.min(end, close);
      if (b > a) minutes += (b - a) / 60_000;
    }
    t = nextDay;
  }
  return Math.floor(minutes);
}

export function escalationDue(activatedAtIso: string, nowIso: string, afterBusinessHours: number, cal: BusinessCalendar = DEFAULT_CALENDAR): boolean {
  return businessMinutesBetween(activatedAtIso, nowIso, cal) >= afterBusinessHours * 60;
}
