/**
 * Pipeline state threaded through the pricing stages. Stages never mutate
 * their input: each returns a new state plus the trace entries it produced.
 */
import {
  type Currency,
  type Money,
  type RoundingMode,
  SCALE_UNIT,
  mulRatio,
  format,
  totalScale,
} from '../money/money.ts';
import type {
  BillingFrequency,
  ChargeType,
  PriceBook,
  PriceBookEntry,
  QuoteConfig,
  QuoteLineConfig,
  RecognitionMethod,
  RuleSet,
  TraceEntry,
} from './types.ts';
import type { EvalContext } from './conditions.ts';

export type LineState = {
  readonly cfg: QuoteLineConfig;
  readonly entry: PriceBookEntry | null;
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  description: string;
  family: string;
  chargeType: ChargeType;
  billingFrequency: BillingFrequency;
  recognitionMethod: RecognitionMethod;
  qty: bigint;
  termMonths: number;
  /** Proration factor num/den: termMonths/12 for recurring, 1/1 for one-time. */
  prorNum: bigint;
  prorDen: bigint;
  listUnit: Money; // unit scale, per year for recurring
  sspUnit: Money; // unit scale
  listExtended: Money; // unit scale, prorated
  /** Post-tier amount — the base discounts are measured against. */
  tierAmount: Money; // unit scale
  /** Running amount through the pipeline. */
  amount: Money; // unit scale
  floor: Money; // unit scale
  manualBp: number;
  appliedRuleIds: string[];
  floorClamped: boolean;
  warnings: string[];
  extended: Money | null; // currency scale
  orderDiscount: Money | null; // currency scale
  net: Money | null; // currency scale
};

export type PricingState = {
  readonly config: QuoteConfig;
  readonly priceBook: PriceBook;
  readonly currency: Currency;
  /** Scale of totals (ISO 4217 minor units). */
  readonly scaleT: number;
  readonly mode: RoundingMode;
  readonly nonStandard: boolean;
  lines: LineState[];
  subtotal: Money | null;
  orderDiscount: Money | null;
  total: Money | null;
  orderRuleIds: string[];
  warnings: string[];
};

export type StageResult = { state: PricingState; trace: TraceEntry[] };
export type Stage = { name: string; run: (s: PricingState, rs: RuleSet) => StageResult };

export function initialState(config: QuoteConfig, rs: RuleSet, pb: PriceBook): PricingState {
  return {
    config,
    priceBook: pb,
    currency: config.currency,
    scaleT: totalScale(config.currency),
    mode: rs.rounding.mode,
    nonStandard: config.quoteType === 'non-standard',
    lines: [],
    subtotal: null,
    orderDiscount: null,
    total: null,
    orderRuleIds: [],
    warnings: [],
  };
}

export function cloneState(s: PricingState): PricingState {
  return {
    ...s,
    lines: s.lines.map((l) => ({ ...l, appliedRuleIds: [...l.appliedRuleIds], warnings: [...l.warnings] })),
    orderRuleIds: [...s.orderRuleIds],
    warnings: [...s.warnings],
  };
}

/** Apply a line's proration factor (term/12 for recurring) at unit scale. */
export function prorate(l: LineState, m: Money, mode: RoundingMode): Money {
  if (m.scale !== SCALE_UNIT) throw new Error('prorate expects unit-scale money');
  return mulRatio(m, l.prorNum, l.prorDen, mode);
}

export function lineContext(l: LineState, s: PricingState): EvalContext {
  return {
    'line.productId': l.productId,
    'line.sku': l.sku,
    'line.family': l.family,
    'line.chargeType': l.chargeType,
    'line.quantity': l.qty,
    'line.termMonths': l.termMonths,
    ...quoteContext(s),
  };
}

export function quoteContext(s: PricingState): EvalContext {
  const c = s.config;
  return {
    'quote.accountId': c.accountId,
    'quote.segment': c.segment,
    'quote.channel': c.channel,
    'quote.promoCodes': [...c.promoCodes].sort(),
    'quote.asOf': c.asOf,
    'quote.termMonths': c.termMonths,
    'quote.quoteType': c.quoteType,
    'quote.paymentNetDays': c.paymentTerms.netDays,
  };
}

export const fmt = format;
