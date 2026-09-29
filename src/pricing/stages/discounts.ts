import {
  SCALE_UNIT,
  applyDiscountBp,
  applyRate,
  bpToPercentString,
  lt,
  maxMoney,
  mulQty,
  parseMoney,
  sub,
  zero,
  type Money,
} from '../../money/money.ts';
import { evaluate } from '../conditions.ts';
import type { DiscountEffect, DiscountRule, StackingPolicy, TraceEntry } from '../types.ts';
import { type Stage, cloneState, lineContext, prorate, fmt } from '../state.ts';

export const MANUAL_RULE_ID = 'manual';

type Candidate = Pick<DiscountRule, 'id' | 'name' | 'priority' | 'stackable' | 'effect'> & { stackGroup?: string };

export type Selection = { selected: Candidate[]; skipped: Array<{ rule: Candidate; reason: string }> };

/**
 * Deterministic greedy selection in (priority, id) order:
 *  - a non-stackable rule is taken only if nothing has been selected yet, and
 *    once taken nothing else may join it;
 *  - within an exclusive group only the first rule is taken;
 *  - an incompatible pair never combines (the earlier rule wins).
 */
export function selectRules(applicable: Candidate[], policy: StackingPolicy): Selection {
  const sorted = [...applicable].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const selected: Candidate[] = [];
  const skipped: Array<{ rule: Candidate; reason: string }> = [];
  const groups = new Set(policy.exclusiveGroups);
  const usedGroups = new Map<string, string>();
  for (const r of sorted) {
    const blocker = selected.find((x) => !x.stackable);
    if (blocker) {
      skipped.push({ rule: r, reason: `non-stackable rule ${blocker.id} already applied` });
      continue;
    }
    if (!r.stackable && selected.length > 0) {
      skipped.push({ rule: r, reason: `non-stackable and ${selected.length} rule(s) already applied` });
      continue;
    }
    if (r.stackGroup && groups.has(r.stackGroup)) {
      const winner = usedGroups.get(r.stackGroup);
      if (winner) {
        skipped.push({ rule: r, reason: `exclusive group "${r.stackGroup}" already used by ${winner}` });
        continue;
      }
    }
    const clash = selected.find((x) => policy.incompatible.some(([p, q]) => (p === x.id && q === r.id) || (p === r.id && q === x.id)));
    if (clash) {
      skipped.push({ rule: r, reason: `incompatible with ${clash.id}` });
      continue;
    }
    selected.push(r);
    if (r.stackGroup && groups.has(r.stackGroup)) usedGroups.set(r.stackGroup, r.id);
  }
  return { selected, skipped };
}

function describeEffect(e: DiscountEffect): string {
  switch (e.type) {
    case 'percent':
      return `${bpToPercentString(e.basisPoints)} off`;
    case 'amount':
      return `${e.perUnit}/unit off`;
    case 'overridePrice':
      return `price override ${e.perUnit}/unit`;
  }
}

/**
 * discounts: applied per line in declared order under the rule set's
 * stacking semantics. Every applied or skipped rule is traced.
 *
 *  multiplicative: each percent applies to what remains.
 *  additive:       each percent is measured against the post-tier amount.
 *  amount/override effects behave identically under both modes.
 *
 * Then the stacking ceiling (maxTotalBasisPoints vs the post-tier amount).
 */
export const discounts: Stage = {
  name: 'discounts',
  run(input, rs) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    if (s.nonStandard) {
      trace.push({ stage: 'discounts', explanation: 'non-standard quote: discount rules not applied', inputs: {} });
      return { state: s, trace };
    }
    const policy = rs.stacking;
    for (const l of s.lines) {
      const ctx = lineContext(l, s);
      const applicable: Candidate[] = rs.discountRules.filter((r) => evaluate(r.condition, ctx));
      if (l.manualBp > 0) {
        applicable.push({
          id: MANUAL_RULE_ID,
          name: 'Rep discount',
          priority: policy.manualPriority,
          stackable: true,
          effect: { type: 'percent', basisPoints: l.manualBp },
        });
      }
      const { selected, skipped } = selectRules(applicable, policy);
      for (const { rule, reason } of skipped) {
        trace.push({
          stage: 'discounts',
          lineId: l.lineId,
          ruleId: rule.id,
          ruleName: rule.name,
          explanation: `skipped: ${reason}`,
          inputs: { priority: rule.priority, applied: false },
        });
      }
      const base = l.tierAmount;
      const z = zero(s.currency, SCALE_UNIT);
      for (const rule of selected) {
        const before = l.amount;
        let after: Money;
        const e = rule.effect;
        switch (e.type) {
          case 'percent':
            after =
              policy.mode === 'multiplicative'
                ? applyDiscountBp(before, BigInt(e.basisPoints), s.mode)
                : sub(before, applyRate(base, BigInt(e.basisPoints), s.mode));
            break;
          case 'amount':
            after = sub(before, prorate(l, mulQty(parseMoney(e.perUnit, s.currency, SCALE_UNIT), l.qty), s.mode));
            break;
          case 'overridePrice':
            after = prorate(l, mulQty(parseMoney(e.perUnit, s.currency, SCALE_UNIT), l.qty), s.mode);
            break;
        }
        if (lt(after, z)) after = z;
        l.amount = after;
        l.appliedRuleIds.push(rule.id);
        trace.push({
          stage: 'discounts',
          lineId: l.lineId,
          ruleId: rule.id,
          ruleName: rule.name,
          before,
          after,
          delta: sub(after, before),
          explanation: `${describeEffect(e)} — ${rule.stackable ? 'stackable' : 'non-stackable'}, priority ${rule.priority}, ${policy.mode}`,
          inputs: { priority: rule.priority, mode: policy.mode, applied: true, effect: e.type },
        });
      }
      // Stacking ceiling
      const minAllowed = applyDiscountBp(base, BigInt(policy.maxTotalBasisPoints), 'ceiling');
      if (selected.length > 0 && lt(l.amount, minAllowed)) {
        const before = l.amount;
        l.amount = maxMoney(minAllowed, z);
        l.warnings.push(`Combined discounts capped at ${bpToPercentString(policy.maxTotalBasisPoints)} (stacking ceiling).`);
        trace.push({
          stage: 'discounts',
          lineId: l.lineId,
          ruleId: 'stacking-ceiling',
          ruleName: 'Stacking ceiling',
          before,
          after: l.amount,
          delta: sub(l.amount, before),
          explanation: `combined discount capped at ${bpToPercentString(policy.maxTotalBasisPoints)} of ${fmt(base)}`,
          inputs: { maxTotalBasisPoints: policy.maxTotalBasisPoints },
        });
      }
    }
    return { state: s, trace };
  },
};
