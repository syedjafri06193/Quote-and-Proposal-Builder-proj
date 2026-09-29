import {
  SCALE_UNIT,
  add,
  applyDiscountBp,
  bpToPercentString,
  discountBp,
  lt,
  maxMoney,
  mulQty,
  mulRatio,
  money,
  parseMoney,
  rescale,
  sub,
  sum,
  upscale,
  zero,
  type Money,
} from '../../money/money.ts';
import { evaluate } from '../conditions.ts';
import type { OrderDiscountRule, RuleSet, TraceEntry } from '../types.ts';
import { type LineState, type PricingState, type Stage, cloneState, prorate, quoteContext, fmt } from '../state.ts';

/** The floor for a line, at unit scale: max(list × (1 − maxDiscount), minUnitPrice × qty × proration). */
export function resolveFloor(l: Pick<LineState, 'productId' | 'listExtended' | 'qty' | 'prorNum' | 'prorDen'>, rs: RuleSet): { floor: Money; reason: string } {
  const p = rs.floors.byProduct.find((x) => x.productId === l.productId);
  const maxBp = p?.maxDiscountBp ?? rs.floors.defaultMaxDiscountBp;
  // 'ceiling' is deliberate: the floor must never round in the customer's favour.
  const byPct = applyDiscountBp(l.listExtended, BigInt(maxBp), 'ceiling');
  let floor = byPct;
  let reason = `max discount ${bpToPercentString(maxBp)}`;
  if (p?.minUnitPrice) {
    const minUnit = parseMoney(p.minUnitPrice, l.listExtended.currency, SCALE_UNIT);
    const byMin = mulRatio(mulQty(minUnit, l.qty), l.prorNum, l.prorDen, 'ceiling');
    if (lt(floor, byMin)) {
      floor = byMin;
      reason = `minimum price ${fmt(minUnit)}/unit`;
    }
  }
  return { floor, reason };
}

/** floors: clamp-and-warn. The clamp is traced and flagged for the UI. */
export const floors: Stage = {
  name: 'floors',
  run(input, rs) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    if (s.nonStandard) return { state: s, trace };
    for (const l of s.lines) {
      const { floor, reason } = resolveFloor(l, rs);
      l.floor = floor;
      const actualBp = discountBp(l.listExtended, l.amount, 'half-up');
      if (lt(l.amount, floor)) {
        const before = l.amount;
        l.amount = floor;
        l.floorClamped = true;
        const msg = `Discount clamped to floor (${reason}): requested ${bpToPercentString(actualBp)} off list, capped at ${fmt(floor)}.`;
        l.warnings.push(msg);
        trace.push({
          stage: 'floors',
          lineId: l.lineId,
          before,
          after: floor,
          delta: sub(floor, before),
          explanation: `clamped to floor ${fmt(floor)} (${reason}); requested ${bpToPercentString(actualBp)} off list`,
          inputs: { floorClamped: true, requestedDiscountBp: actualBp },
        });
      } else {
        trace.push({
          stage: 'floors',
          lineId: l.lineId,
          before: l.amount,
          after: l.amount,
          delta: zero(s.currency, SCALE_UNIT),
          explanation: `floor check OK — ${reason}, actual ${bpToPercentString(actualBp)} off list`,
          inputs: { floorClamped: false, actualDiscountBp: actualBp },
        });
      }
    }
    return { state: s, trace };
  },
};

/** round: the single rounding point — each line's extended amount, to the currency's minor units. */
export const rounding: Stage = {
  name: 'rounding',
  run(input, rs) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    for (const l of s.lines) {
      const ext = rescale(l.amount, s.scaleT, s.mode);
      l.extended = ext;
      trace.push({
        stage: 'rounding',
        lineId: l.lineId,
        before: l.amount,
        after: upscale(ext, SCALE_UNIT),
        delta: sub(upscale(ext, SCALE_UNIT), l.amount),
        explanation: `rounded ${rs.rounding.mode} at line to ${s.scaleT} dp: ${fmt(ext)}`,
        inputs: { mode: rs.rounding.mode, scale: s.scaleT },
      });
    }
    return { state: s, trace };
  },
};

/**
 * Allocate `total` across weights proportionally, largest-remainder method,
 * ties broken by key. The parts always sum exactly to `total`.
 */
export function allocate(total: bigint, items: Array<{ key: string; weight: bigint; cap: bigint }>): Map<string, bigint> {
  const out = new Map<string, bigint>(items.map((i) => [i.key, 0n]));
  let remaining = total;
  let open = items.filter((i) => i.cap > 0n && i.weight > 0n);
  // Iterate: proportional split; any part above its cap is pinned at cap and the excess is re-split.
  for (let guard = 0; remaining > 0n && open.length > 0 && guard < items.length + 2; guard++) {
    const W = open.reduce((a, i) => a + i.weight, 0n);
    const shares = open.map((i) => {
      const num = remaining * i.weight;
      return { i, q: num / W, r: num % W };
    });
    let used = shares.reduce((a, x) => a + x.q, 0n);
    const order = [...shares].sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i.key.localeCompare(b.i.key)));
    for (const x of order) {
      if (used >= remaining) break;
      x.q += 1n;
      used += 1n;
    }
    let overflow = false;
    for (const x of shares) {
      const room = x.i.cap - (out.get(x.i.key) ?? 0n);
      if (x.q > room) {
        overflow = true;
        break;
      }
    }
    if (!overflow) {
      for (const x of shares) out.set(x.i.key, (out.get(x.i.key) ?? 0n) + x.q);
      remaining = 0n;
      break;
    }
    // pin the capped lines and retry with the rest
    const next: typeof open = [];
    for (const x of shares) {
      const room = x.i.cap - (out.get(x.i.key) ?? 0n);
      if (x.q >= room) {
        out.set(x.i.key, x.i.cap);
        remaining -= room;
      } else next.push(x.i);
    }
    open = next;
  }
  return out;
}

/**
 * order-level: order discounts on the subtotal, then allocated back to lines
 * in proportion to their extended amounts (largest remainder, so lines sum
 * exactly to the total). Allocation never pushes a line below its floor;
 * any discount that can't be allocated without breaching is dropped and warned.
 */
export const orderLevel: Stage = {
  name: 'order-level',
  run(input, rs) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    const exts = s.lines.map((l) => l.extended!);
    const subtotal = sum(exts, s.currency, s.scaleT);
    s.subtotal = subtotal;

    const ctx = { ...quoteContext(s), 'quote.subtotal': toDec(subtotal) };
    const rules: Array<Pick<OrderDiscountRule, 'id' | 'name' | 'priority' | 'basisPoints'>> = s.nonStandard
      ? []
      : rs.orderDiscountRules.filter((r) => evaluate(r.condition, ctx));
    const manual = s.config.orderManualDiscountBp ?? 0;
    if (manual > 0) rules.push({ id: 'order-manual', name: 'Rep order discount', priority: rs.stacking.manualPriority, basisPoints: manual });
    rules.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    let discounted = subtotal;
    for (const r of rules) {
      const before = discounted;
      discounted =
        rs.stacking.mode === 'multiplicative'
          ? applyDiscountBp(discounted, BigInt(r.basisPoints), s.mode)
          : sub(discounted, mulRatio(subtotal, BigInt(r.basisPoints), 10_000n, s.mode));
      if (lt(discounted, zero(s.currency, s.scaleT))) discounted = zero(s.currency, s.scaleT);
      s.orderRuleIds.push(r.id);
      trace.push({
        stage: 'order-level',
        ruleId: r.id,
        ruleName: r.name,
        before,
        after: discounted,
        delta: sub(discounted, before),
        explanation: `order discount ${bpToPercentString(r.basisPoints)} (${rs.stacking.mode}) on subtotal ${fmt(subtotal)}`,
        inputs: { basisPoints: r.basisPoints, priority: r.priority },
      });
    }
    let orderDiscount = sub(subtotal, discounted);

    // headroom above each line's floor, at currency scale
    const items = s.lines.map((l) => {
      const floorT = s.nonStandard ? zero(s.currency, s.scaleT) : rescale(l.floor, s.scaleT, s.mode);
      const room = maxMoney(sub(l.extended!, floorT), zero(s.currency, s.scaleT));
      return { key: l.lineId, weight: l.extended!.minor, cap: room.minor };
    });
    const capacity = items.reduce((a, i) => a + i.cap, 0n);
    if (orderDiscount.minor > capacity) {
      const want = orderDiscount;
      orderDiscount = money(capacity, s.currency, s.scaleT);
      const msg = `Order discount reduced from ${fmt(want)} to ${fmt(orderDiscount)} to keep every line at or above its floor.`;
      s.warnings.push(msg);
      trace.push({
        stage: 'order-level',
        ruleId: 'floor-guard',
        ruleName: 'Floor guard',
        before: want,
        after: orderDiscount,
        delta: sub(orderDiscount, want),
        explanation: msg,
        inputs: { floorClamped: true },
      });
    }
    const shares = allocate(orderDiscount.minor, items);
    for (const l of s.lines) {
      const share = money(shares.get(l.lineId) ?? 0n, s.currency, s.scaleT);
      l.orderDiscount = share;
      l.net = sub(l.extended!, share);
      if (share.minor > 0n) {
        trace.push({
          stage: 'order-level',
          lineId: l.lineId,
          ruleId: 'allocation',
          before: l.extended!,
          after: l.net,
          delta: sub(l.net, l.extended!),
          explanation: `order discount allocated pro-rata by line amount (largest remainder)`,
          inputs: { share: share.minor.toString() },
        });
      }
    }
    s.orderDiscount = orderDiscount;
    s.total = sum(
      s.lines.map((l) => l.net!),
      s.currency,
      s.scaleT,
    );
    if (s.total.minor !== sub(subtotal, orderDiscount).minor) throw new Error('internal: allocation does not sum');
    trace.push({
      stage: 'order-level',
      before: subtotal,
      after: s.total,
      delta: sub(s.total, subtotal),
      explanation: `total ${fmt(s.total)}`,
      inputs: {},
    });
    return { state: s, trace };
  },
};

/** tax: never built here. Delegated to Avalara / Stripe Tax at invoice time. */
export const tax: Stage = {
  name: 'tax',
  run(s) {
    return {
      state: s,
      trace: [{ stage: 'tax', explanation: 'tax is delegated to the tax provider and is not included in quote totals', inputs: { provider: 'external' } }],
    };
  },
};

function toDec(m: Money): string {
  const neg = m.minor < 0n;
  const a = (neg ? -m.minor : m.minor).toString().padStart(m.scale + 1, '0');
  return (neg ? '-' : '') + (m.scale ? a.slice(0, -m.scale) + '.' + a.slice(-m.scale) : a);
}

export { add };
export type { PricingState };
