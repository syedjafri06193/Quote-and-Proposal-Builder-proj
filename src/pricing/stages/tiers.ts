import { SCALE_UNIT, add, mulQty, parseMoney, sub, zero, type Money } from '../../money/money.ts';
import type { TierTable, TraceEntry } from '../types.ts';
import { type LineState, type Stage, cloneState, prorate, fmt } from '../state.ts';

/**
 * Price a quantity against a tier table (design guide §3.3, §18.1).
 * Returns the per-year (un-prorated) amount at unit scale plus band detail.
 *
 * - graduated: each band prices its own units, like tax brackets. Monotonic.
 * - volume: all units price at the band the quantity lands in. Creates cliffs.
 *
 * Quantities below the first band's `fromQty` price at list.
 */
export function priceTierTable(
  table: TierTable,
  qty: bigint,
  listUnit: Money,
): { amount: Money; bands: Array<{ bandId: string; units: bigint; unitPrice: Money; amount: Money }> } {
  const cur = listUnit.currency;
  const bands = [...table.bands]
    .map((b) => ({ id: b.id, from: BigInt(b.fromQty), price: parseMoney(b.unitPrice, cur, SCALE_UNIT) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id.localeCompare(b.id)));

  const first = bands[0];
  if (!first || qty < first.from) {
    return { amount: mulQty(listUnit, qty), bands: [{ bandId: 'list', units: qty, unitPrice: listUnit, amount: mulQty(listUnit, qty) }] };
  }

  if (table.model === 'volume') {
    let landed = first;
    for (const b of bands) if (qty >= b.from) landed = b;
    const amount = mulQty(landed.price, qty);
    return { amount, bands: [{ bandId: landed.id, units: qty, unitPrice: landed.price, amount }] };
  }

  // graduated; units below the first band (if it doesn't start at 1) price at list
  let total = zero(cur, SCALE_UNIT);
  const detail: Array<{ bandId: string; units: bigint; unitPrice: Money; amount: Money }> = [];
  if (first.from > 1n) {
    const pre = first.from - 1n;
    const amt = mulQty(listUnit, pre);
    total = add(total, amt);
    detail.push({ bandId: 'list', units: pre, unitPrice: listUnit, amount: amt });
  }
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]!;
    if (qty < b.from) break;
    const next = bands[i + 1];
    const upperExclusive = next ? next.from : qty + 1n;
    const top = qty + 1n < upperExclusive ? qty + 1n : upperExclusive;
    const units = top - b.from;
    if (units <= 0n) continue;
    const amt = mulQty(b.price, units);
    total = add(total, amt);
    detail.push({ bandId: b.id, units, unitPrice: b.price, amount: amt });
  }
  return { amount: total, bands: detail };
}

export function tierTableFor(tables: readonly TierTable[], productId: string): TierTable | undefined {
  // Deterministic: first by id if (invalidly) more than one exists; publish validation forbids that.
  return [...tables].filter((t) => t.productId === productId).sort((a, b) => a.id.localeCompare(b.id))[0];
}

export const tiers: Stage = {
  name: 'tiers',
  run(input, rs) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    if (s.nonStandard) return { state: s, trace };
    for (const l of s.lines) {
      const table = tierTableFor(rs.tiers, l.productId);
      if (!table) continue;
      const res = priceTierTable(table, l.qty, l.listUnit);
      const before = l.amount;
      const after = prorate(l, res.amount, s.mode);
      l.tierAmount = after;
      l.amount = after;
      const bandText = res.bands.map((b) => `${b.units} @ ${fmt(b.unitPrice)}`).join(' + ');
      trace.push({
        stage: 'tiers',
        lineId: l.lineId,
        ruleId: table.id,
        ruleName: table.name,
        before,
        after,
        delta: sub(after, before),
        explanation: `${table.model} tiers: ${bandText}` + (l.chargeType === 'recurring' ? ` (per year, × ${l.termMonths}/12)` : ''),
        inputs: { model: table.model, quantity: l.qty.toString(), bands: res.bands.map((b) => b.bandId).join(',') },
      });
    }
    return { state: s, trace };
  },
};

export type { LineState };
