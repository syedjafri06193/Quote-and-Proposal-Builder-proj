/**
 * The pricing engine (design guide §6).
 *
 * `priceQuote` is a pure function: same (config, rule set, price book) →
 * structurally identical output, forever. No clock, no I/O, no randomness,
 * explicit sort before every iteration that could depend on input order.
 * That property is what the replay test (§4.3) relies on.
 */
import { SCALE_UNIT, discountBp, mulRatio, rescale, sum, upscale } from '../money/money.ts';
import type { PriceBook, PricedLine, PricedQuote, QuoteConfig, RuleSet, TraceEntry } from './types.ts';
import { type PricingState, type Stage, initialState } from './state.ts';
import { configure, basePrice } from './stages/configure.ts';
import { tiers } from './stages/tiers.ts';
import { discounts } from './stages/discounts.ts';
import { floors, rounding, orderLevel, tax } from './stages/floors.ts';

export const PIPELINE: readonly Stage[] = [configure, basePrice, tiers, discounts, floors, rounding, orderLevel, tax];

export const ENGINE_VERSION = '1.0.0';

export function priceQuote(config: QuoteConfig, rs: RuleSet, pb: PriceBook): PricedQuote {
  let state = initialState(config, rs, pb);
  const trace: TraceEntry[] = [];
  for (const stage of PIPELINE) {
    const r = stage.run(state, rs);
    state = r.state;
    trace.push(...r.trace);
  }
  return materialize(state, rs, trace);
}

function materialize(s: PricingState, rs: RuleSet, trace: TraceEntry[]): PricedQuote {
  const lines: PricedLine[] = s.lines.map((l) => {
    const net = l.net!;
    const listExtT = rescale(l.listExtended, s.scaleT, s.mode);
    // effective per-unit price (per year for recurring): net / (qty × proration)
    const unitPrice = mulRatio(upscale(net, SCALE_UNIT), l.prorDen, l.qty * l.prorNum, s.mode);
    return {
      lineId: l.lineId,
      productId: l.productId,
      sku: l.sku,
      name: l.name,
      description: l.description,
      chargeType: l.chargeType,
      billingFrequency: l.billingFrequency,
      recognitionMethod: l.recognitionMethod,
      quantity: l.qty,
      termMonths: l.termMonths,
      listUnitPrice: l.listUnit,
      sspUnitPrice: l.sspUnit,
      listExtended: listExtT,
      extended: l.extended!,
      orderDiscount: l.orderDiscount!,
      net,
      unitPrice,
      totalDiscountBasisPoints: discountBp(listExtT, net, 'half-up'),
      manualDiscountBp: l.manualBp,
      appliedRuleIds: [...l.appliedRuleIds, ...(l.orderDiscount!.minor > 0n ? s.orderRuleIds : [])],
      floorClamped: l.floorClamped,
      warnings: l.warnings,
    };
  });
  const listTotal = sum(
    lines.map((l) => l.listExtended),
    s.currency,
    s.scaleT,
  );
  const total = s.total!;
  const warnings = [...lines.flatMap((l) => l.warnings.map((w) => `${l.sku}: ${w}`)), ...s.warnings];
  return {
    quoteType: s.config.quoteType,
    currency: s.currency,
    ruleSetVersion: rs.version,
    priceBookVersion: s.priceBook.version,
    asOf: s.config.asOf,
    startDate: s.config.startDate,
    termMonths: s.config.termMonths,
    paymentTerms: { ...s.config.paymentTerms },
    legalTermsVersion: s.config.legalTermsVersion,
    lines,
    listTotal,
    subtotal: s.subtotal!,
    orderDiscount: s.orderDiscount!,
    total,
    totalDiscountBasisPoints: discountBp(listTotal, total, 'half-up'),
    maxLineDiscountBasisPoints: lines.reduce((m, l) => Math.max(m, l.totalDiscountBasisPoints), 0),
    floorClamped: lines.some((l) => l.floorClamped) || s.warnings.length > 0,
    warnings,
    tax: { status: 'delegated', provider: 'external' },
    trace,
  };
}
