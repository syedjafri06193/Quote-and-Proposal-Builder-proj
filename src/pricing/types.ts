/**
 * Domain types for the catalog, price books, rule sets, quote configuration
 * and priced (materialized) quotes. These are plain data: rule sets and price
 * books are JSON documents that are versioned and immutable once published.
 */
import type { Currency, Money, RoundingMode } from '../money/money.ts';
import type { Condition } from './conditions.ts';

// ───────────────────────── Catalog / price book ─────────────────────────

export type ChargeType = 'recurring' | 'one-time';
export type BillingFrequency = 'monthly' | 'quarterly' | 'annual' | 'one-time';
export type RecognitionMethod = 'ratable' | 'point-in-time';

/** A product as captured in a price-book version. */
export type PriceBookEntry = {
  productId: string;
  sku: string;
  name: string;
  family: string;
  description: string;
  chargeType: ChargeType;
  /** Recurring products are priced per unit per YEAR; one-time per unit. Decimal string, up to 6 dp. */
  listPrice: string;
  /** Standalone selling price per unit (same basis as listPrice); for ASC 606 allocation downstream. */
  ssp?: string;
  billingFrequency: BillingFrequency;
  recognitionMethod: RecognitionMethod;
  requires?: string[];
  excludes?: string[];
  active: boolean;
  /** Maximum quantity used by cliff detection tests. */
  maxTestQty?: number;
};

export type PriceBook = {
  version: number;
  currency: Currency;
  publishedAt: string;
  entries: PriceBookEntry[];
};

// ───────────────────────── Rule set ─────────────────────────

export type TierModel = 'graduated' | 'volume';

export type TierBand = { id: string; fromQty: number; unitPrice: string };

export type TierTable = {
  id: string;
  name: string;
  productId: string;
  model: TierModel;
  bands: TierBand[];
};

export type DiscountEffect =
  | { type: 'percent'; basisPoints: number }
  /** Per-unit amount off, decimal string at unit precision (per year for recurring). */
  | { type: 'amount'; perUnit: string }
  /** Per-unit price override, decimal string at unit precision. */
  | { type: 'overridePrice'; perUnit: string };

export type DiscountRule = {
  id: string;
  name: string;
  /** Explicit application order: lower applies first. Ties broken by id. */
  priority: number;
  stackable: boolean;
  /** Rules in the same exclusive group are mutually exclusive; the first by (priority, id) wins. */
  stackGroup?: string;
  /** Evaluated with scopes `line` and `quote`. */
  condition: Condition;
  effect: DiscountEffect;
};

export type OrderDiscountRule = {
  id: string;
  name: string;
  priority: number;
  /** Evaluated with scope `quote` (subtotal available). */
  condition: Condition;
  basisPoints: number;
};

export type StackingPolicy = {
  mode: 'additive' | 'multiplicative';
  exclusiveGroups: string[];
  incompatible: Array<[string, string]>;
  /** Hard ceiling on combined line-level discount relative to the post-tier amount. */
  maxTotalBasisPoints: number;
  /** Priority slot of the rep-entered manual discount among the rules. */
  manualPriority: number;
};

export type FloorPolicy = {
  /** Max discount vs list, applied unless the product overrides it. */
  defaultMaxDiscountBp: number;
  byProduct: Array<{ productId: string; maxDiscountBp?: number; minUnitPrice?: string }>;
  /** What happens when a line would breach: only clamp-and-warn is supported in v1. */
  behavior: 'clamp-and-warn';
};

export type RoundingPolicy = {
  mode: RoundingMode;
  /** v1 supports exactly one rounding point: each line's extended amount. */
  point: 'line';
};

export type ApproverSpec =
  | { type: 'role'; role: string }
  | { type: 'user'; userId: string }
  | { type: 'manager-of'; userId: 'owner' | string; levels: number };

export type ApprovalRule = {
  id: string;
  name: string;
  /** Evaluated with scope `approval`. */
  condition: Condition;
  approvers: ApproverSpec[];
  mode: 'sequential' | 'parallel';
  order: number;
  /** Human-readable policy text used in approval notifications. */
  reason: string;
};

export type RuleSetDefinition = {
  currency: Currency;
  rounding: RoundingPolicy;
  stacking: StackingPolicy;
  tiers: TierTable[];
  discountRules: DiscountRule[];
  orderDiscountRules: OrderDiscountRule[];
  floors: FloorPolicy;
  approvalRules: ApprovalRule[];
  /** Always required for non-standard quotes, on top of anything else. */
  nonStandardApprovers: ApproverSpec[];
  /** Escalation after N business hours without a decision. */
  escalation: { afterBusinessHours: number };
};

export type RuleSet = RuleSetDefinition & {
  version: number;
  /** ISO timestamp. */
  effectiveFrom: string;
};

// ───────────────────────── Quote configuration (input) ─────────────────────────

export type QuoteLineConfig = {
  lineId: string;
  /** For non-standard quotes, may be a free-form id such as "custom-1". */
  productId: string;
  /** Integer quantity as a decimal string. */
  quantity: string;
  /** Recurring lines only; defaults to the quote term. */
  termMonths?: number;
  /** Rep-entered discount in bp; subject to floors and approvals. */
  manualDiscountBp?: number;
  /** Non-standard quotes only. */
  description?: string;
  /** Non-standard quotes only: manually entered unit price (per year for recurring). */
  manualUnitPrice?: string;
  /** Non-standard quotes only. */
  chargeType?: ChargeType;
};

export type QuoteConfig = {
  quoteType: 'standard' | 'non-standard';
  /** Required for non-standard quotes: why the standard model can't express this deal. */
  nonStandardReason?: string;
  currency: Currency;
  accountId: string;
  segment: string;
  channel: string;
  promoCodes: string[];
  /** Pricing "as of" date (YYYY-MM-DD) — explicit input; the engine never reads the clock. */
  asOf: string;
  startDate: string;
  termMonths: number;
  paymentTerms: { netDays: number; method: string };
  legalTermsVersion: string;
  autoRenew: boolean;
  noticePeriodDays: number;
  orderManualDiscountBp?: number;
  lines: QuoteLineConfig[];
  /** Cosmetic: excluded from the approval fingerprint. */
  cover: { title: string; intro: string; preparedFor: string };
};

// ───────────────────────── Trace ─────────────────────────

export type TraceEntry = {
  stage: string;
  lineId?: string;
  ruleId?: string;
  ruleName?: string;
  before?: Money;
  after?: Money;
  delta?: Money;
  explanation: string;
  inputs: Record<string, string | number | boolean | null>;
};

// ───────────────────────── Priced quote (output) ─────────────────────────

export type PricedLine = {
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  description: string;
  chargeType: ChargeType;
  billingFrequency: BillingFrequency;
  recognitionMethod: RecognitionMethod;
  quantity: bigint;
  termMonths: number;
  listUnitPrice: Money; // unit scale
  sspUnitPrice: Money; // unit scale
  listExtended: Money; // currency scale
  /** Line amount after tiers/discounts/floors, rounded — before order-level discount. */
  extended: Money;
  orderDiscount: Money;
  /** Final line amount: extended − order discount allocation. */
  net: Money;
  /** Effective net price per unit (per year for recurring), unit scale. */
  unitPrice: Money;
  totalDiscountBasisPoints: number;
  manualDiscountBp: number;
  appliedRuleIds: string[];
  floorClamped: boolean;
  warnings: string[];
};

export type PricedQuote = {
  quoteType: 'standard' | 'non-standard';
  currency: Currency;
  ruleSetVersion: number;
  priceBookVersion: number;
  asOf: string;
  startDate: string;
  termMonths: number;
  paymentTerms: { netDays: number; method: string };
  legalTermsVersion: string;
  lines: PricedLine[];
  listTotal: Money;
  subtotal: Money;
  orderDiscount: Money;
  total: Money;
  totalDiscountBasisPoints: number;
  maxLineDiscountBasisPoints: number;
  floorClamped: boolean;
  warnings: string[];
  tax: { status: 'delegated'; provider: string };
  trace: TraceEntry[];
};

export class PricingError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [message],
  ) {
    super(message);
    this.name = 'PricingError';
  }
}
