/**
 * Publish-time validation of a rule set definition (design guide §6.3, §12).
 * A rule set that fails validation cannot be simulated, approved or published.
 */
import { ROUNDING_MODES, parseMoney, SCALE_UNIT, CURRENCY_MINOR_UNITS, type Currency } from '../money/money.ts';
import { validateCondition } from '../pricing/conditions.ts';
import type { ApproverSpec, PriceBook, RuleSetDefinition } from '../pricing/types.ts';

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const isBp = (n: unknown): boolean => isInt(n) && n >= 0 && n <= 10_000;

export type ValidationResult = { errors: string[]; warnings: string[] };

export function validateRuleSet(def: RuleSetDefinition, ctx: { priceBook: PriceBook; roles: Set<string>; userIds: Set<string> }): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const e = (m: string) => errors.push(m);

  if (!def || typeof def !== 'object') return { errors: ['definition must be an object'], warnings };
  if (!(def.currency in CURRENCY_MINOR_UNITS)) e(`unknown currency ${String(def.currency)}`);
  const cur = def.currency as Currency;
  const products = new Set(ctx.priceBook.entries.map((p) => p.productId));
  const price = (s: unknown, where: string) => {
    if (typeof s !== 'string') return e(`${where}: price must be a decimal string`);
    try {
      const m = parseMoney(s, cur, SCALE_UNIT);
      if (m.minor < 0n) e(`${where}: price cannot be negative`);
    } catch (x) {
      e(`${where}: ${(x as Error).message}`);
    }
  };
  const product = (id: unknown, where: string) => {
    if (typeof id !== 'string' || !products.has(id)) warnings.push(`${where}: product ${String(id)} is not in price book v${ctx.priceBook.version}`);
  };

  // rounding
  if (!def.rounding || !ROUNDING_MODES.includes(def.rounding.mode)) e(`rounding.mode must be one of ${ROUNDING_MODES.join(', ')}`);
  if (def.rounding?.point !== 'line') e(`rounding.point must be "line" in v1`);

  // stacking
  const st = def.stacking;
  if (!st) e('stacking is required');
  else {
    if (st.mode !== 'additive' && st.mode !== 'multiplicative') e('stacking.mode must be additive or multiplicative');
    if (!isBp(st.maxTotalBasisPoints)) e('stacking.maxTotalBasisPoints must be 0–10000');
    if (!isInt(st.manualPriority)) e('stacking.manualPriority must be an integer');
    if (!Array.isArray(st.exclusiveGroups)) e('stacking.exclusiveGroups must be an array');
    if (!Array.isArray(st.incompatible) || st.incompatible.some((p) => !Array.isArray(p) || p.length !== 2)) e('stacking.incompatible must be an array of pairs');
  }

  // tiers
  const tierProducts = new Set<string>();
  const ids = new Set<string>();
  const uniq = (id: unknown, where: string) => {
    if (typeof id !== 'string' || !id) return e(`${where}: id required`);
    if (ids.has(id)) e(`${where}: duplicate id "${id}"`);
    ids.add(id);
  };
  for (const [i, t] of (def.tiers ?? []).entries()) {
    const w = `tiers[${i}] (${t.id})`;
    uniq(t.id, w);
    product(t.productId, w);
    if (tierProducts.has(t.productId)) e(`${w}: product ${t.productId} has more than one tier table`);
    tierProducts.add(t.productId);
    if (t.model !== 'graduated' && t.model !== 'volume') e(`${w}: model must be graduated or volume`);
    if (!Array.isArray(t.bands) || t.bands.length === 0) e(`${w}: needs at least one band`);
    else {
      let prev = 0;
      for (const [j, b] of t.bands.entries()) {
        if (!isInt(b.fromQty) || b.fromQty < 1) e(`${w}.bands[${j}]: fromQty must be a positive integer`);
        if (b.fromQty <= prev) e(`${w}.bands[${j}]: fromQty must be strictly ascending`);
        prev = b.fromQty;
        price(b.unitPrice, `${w}.bands[${j}]`);
      }
      if (t.bands[0]?.fromQty !== 1) warnings.push(`${w}: first band starts at ${t.bands[0]?.fromQty}; lower quantities price at list`);
    }
  }

  // discount rules
  for (const [i, r] of (def.discountRules ?? []).entries()) {
    const w = `discountRules[${i}] (${r.id})`;
    uniq(r.id, w);
    if (!r.name) e(`${w}: name required`);
    if (!isInt(r.priority)) e(`${w}: priority must be an integer`);
    if (typeof r.stackable !== 'boolean') e(`${w}: stackable must be boolean`);
    errors.push(...validateCondition(r.condition, ['line', 'quote'], `${w}.condition`));
    const ef = r.effect;
    if (!ef) e(`${w}: effect required`);
    else if (ef.type === 'percent') {
      if (!isBp(ef.basisPoints)) e(`${w}: basisPoints must be 0–10000`);
    } else if (ef.type === 'amount' || ef.type === 'overridePrice') price(ef.perUnit, w);
    else e(`${w}: unknown effect type`);
    if (r.stackGroup && st && !st.exclusiveGroups.includes(r.stackGroup)) warnings.push(`${w}: stackGroup "${r.stackGroup}" is not an exclusive group, so it has no effect`);
  }
  if (ids.has('manual')) e('rule id "manual" is reserved for the rep discount');
  for (const pair of st?.incompatible ?? []) for (const id of pair) if (!ids.has(id)) warnings.push(`stacking.incompatible references unknown rule ${id}`);

  for (const [i, r] of (def.orderDiscountRules ?? []).entries()) {
    const w = `orderDiscountRules[${i}] (${r.id})`;
    uniq(r.id, w);
    if (!isInt(r.priority)) e(`${w}: priority must be an integer`);
    if (!isBp(r.basisPoints)) e(`${w}: basisPoints must be 0–10000`);
    errors.push(...validateCondition(r.condition, ['quote'], `${w}.condition`));
  }

  // floors
  const f = def.floors;
  if (!f) e('floors is required');
  else {
    if (!isBp(f.defaultMaxDiscountBp)) e('floors.defaultMaxDiscountBp must be 0–10000');
    if (f.behavior !== 'clamp-and-warn') e('floors.behavior must be "clamp-and-warn" in v1');
    for (const [i, p] of (f.byProduct ?? []).entries()) {
      product(p.productId, `floors.byProduct[${i}]`);
      if (p.maxDiscountBp !== undefined && !isBp(p.maxDiscountBp)) e(`floors.byProduct[${i}]: maxDiscountBp must be 0–10000`);
      if (p.minUnitPrice !== undefined) price(p.minUnitPrice, `floors.byProduct[${i}]`);
    }
    if (st && f && st.maxTotalBasisPoints > 10_000) e('stacking ceiling above 100%');
  }

  // approvals
  const approver = (a: ApproverSpec, w: string) => {
    if (a.type === 'role') {
      if (!ctx.roles.has(a.role)) e(`${w}: no user holds role "${a.role}"`);
    } else if (a.type === 'user') {
      if (!ctx.userIds.has(a.userId)) e(`${w}: unknown user ${a.userId}`);
    } else if (a.type === 'manager-of') {
      if (!isInt(a.levels) || a.levels < 1 || a.levels > 5) e(`${w}: levels must be 1–5`);
    } else e(`${w}: unknown approver type`);
  };
  const aIds = new Set<string>();
  for (const [i, r] of (def.approvalRules ?? []).entries()) {
    const w = `approvalRules[${i}] (${r.id})`;
    if (aIds.has(r.id)) e(`${w}: duplicate id`);
    aIds.add(r.id);
    if (r.mode !== 'sequential' && r.mode !== 'parallel') e(`${w}: mode must be sequential or parallel`);
    if (!isInt(r.order)) e(`${w}: order must be an integer`);
    if (!Array.isArray(r.approvers) || r.approvers.length === 0) e(`${w}: needs approvers`);
    else r.approvers.forEach((a, j) => approver(a, `${w}.approvers[${j}]`));
    if (!r.reason) warnings.push(`${w}: no reason text — approvers will see a bare request`);
    errors.push(...validateCondition(r.condition, ['approval'], `${w}.condition`));
  }
  if (!Array.isArray(def.nonStandardApprovers) || def.nonStandardApprovers.length === 0)
    e('nonStandardApprovers must name the top approval tier');
  else def.nonStandardApprovers.forEach((a, j) => approver(a, `nonStandardApprovers[${j}]`));
  if (!def.escalation || !isInt(def.escalation.afterBusinessHours) || def.escalation.afterBusinessHours < 1) e('escalation.afterBusinessHours must be ≥ 1');

  return { errors, warnings };
}
