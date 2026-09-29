/**
 * Seed data: a small catalog, rule set v1, a user directory and customer
 * accounts. Everything here is data — the engine has no product knowledge.
 */
import type { PriceBook, RuleSetDefinition } from '../pricing/types.ts';

export const PRICE_BOOK_V1: PriceBook = {
  version: 1,
  currency: 'USD',
  publishedAt: '2026-01-01T00:00:00.000Z',
  entries: [
    {
      productId: 'plat',
      sku: 'PLT-SEAT',
      name: 'Platform License',
      family: 'platform',
      description: 'Per-seat annual subscription to the core platform.',
      chargeType: 'recurring',
      listPrice: '240',
      ssp: '228',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      active: true,
      maxTestQty: 700,
    },
    {
      productId: 'api',
      sku: 'API-CALL',
      name: 'API Calls (annual commit)',
      family: 'usage-commit',
      description: 'Committed annual API call volume, priced per call.',
      chargeType: 'recurring',
      listPrice: '0.0012',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      requires: ['plat'],
      active: true,
      maxTestQty: 12000000,
    },
    {
      productId: 'sso',
      sku: 'ADD-SSO',
      name: 'SSO & SCIM Add-on',
      family: 'platform',
      description: 'Single sign-on and SCIM provisioning.',
      chargeType: 'recurring',
      listPrice: '2400',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      requires: ['plat'],
      active: true,
      maxTestQty: 3,
    },
    {
      productId: 'prem',
      sku: 'SUP-PREM',
      name: 'Premium Support',
      family: 'support',
      description: '24×7 support with a 1-hour P1 response SLA.',
      chargeType: 'recurring',
      listPrice: '12000',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      excludes: ['std-sup'],
      active: true,
      maxTestQty: 3,
    },
    {
      productId: 'std-sup',
      sku: 'SUP-STD',
      name: 'Standard Support',
      family: 'support',
      description: 'Business-hours support.',
      chargeType: 'recurring',
      listPrice: '0',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      active: true,
      maxTestQty: 3,
    },
    {
      productId: 'onb',
      sku: 'SVC-ONB',
      name: 'Onboarding Package',
      family: 'services',
      description: 'Fixed-scope onboarding: configuration, data import, admin training.',
      chargeType: 'one-time',
      listPrice: '5000',
      billingFrequency: 'one-time',
      recognitionMethod: 'point-in-time',
      active: true,
      maxTestQty: 5,
    },
    {
      productId: 'train',
      sku: 'SVC-TRN',
      name: 'Training Day',
      family: 'services',
      description: 'One day of instructor-led training (up to 15 attendees).',
      chargeType: 'one-time',
      listPrice: '1800',
      billingFrequency: 'one-time',
      recognitionMethod: 'point-in-time',
      active: true,
      maxTestQty: 30,
    },
    {
      productId: 'legacy',
      sku: 'OLD-SEAT',
      name: 'Legacy Seat (retired)',
      family: 'platform',
      description: 'Retired SKU — not sellable.',
      chargeType: 'recurring',
      listPrice: '180',
      billingFrequency: 'annual',
      recognitionMethod: 'ratable',
      active: false,
    },
  ],
};

export const RULE_SET_V1: RuleSetDefinition = {
  currency: 'USD',
  rounding: { mode: 'half-up', point: 'line' },
  stacking: {
    mode: 'multiplicative',
    exclusiveGroups: ['promo'],
    incompatible: [['nonprofit-price', 'multi-year']],
    maxTotalBasisPoints: 5000,
    manualPriority: 40,
  },
  tiers: [
    {
      id: 'tier_platform_v1',
      name: 'Platform seat tiers',
      productId: 'plat',
      model: 'graduated',
      bands: [
        { id: 'plat-1', fromQty: 1, unitPrice: '240' },
        { id: 'plat-100', fromQty: 100, unitPrice: '216' },
        { id: 'plat-250', fromQty: 250, unitPrice: '192' },
        { id: 'plat-500', fromQty: 500, unitPrice: '168' },
      ],
    },
    {
      id: 'tier_api_v1',
      name: 'API commit volume tiers',
      productId: 'api',
      model: 'volume',
      bands: [
        { id: 'api-1', fromQty: 1, unitPrice: '0.0012' },
        { id: 'api-1m', fromQty: 1000000, unitPrice: '0.0010' },
        { id: 'api-10m', fromQty: 10000000, unitPrice: '0.0008' },
      ],
    },
    {
      id: 'tier_training_v1',
      name: 'Training day volume tiers',
      productId: 'train',
      model: 'volume',
      bands: [
        { id: 'train-1', fromQty: 1, unitPrice: '1800' },
        { id: 'train-5', fromQty: 5, unitPrice: '1500' },
      ],
    },
  ],
  discountRules: [
    {
      id: 'nonprofit-price',
      name: 'Nonprofit seat price',
      priority: 10,
      stackable: false,
      condition: { op: 'and', terms: [{ op: 'eq', field: 'quote.segment', value: 'nonprofit' }, { op: 'eq', field: 'line.productId', value: 'plat' }] },
      effect: { type: 'overridePrice', perUnit: '150' },
    },
    {
      id: 'partner-gold',
      name: 'Gold partner discount',
      priority: 20,
      stackable: true,
      condition: { op: 'and', terms: [{ op: 'eq', field: 'quote.channel', value: 'partner-gold' }, { op: 'eq', field: 'line.chargeType', value: 'recurring' }] },
      effect: { type: 'percent', basisPoints: 1000 },
    },
    {
      id: 'partner-silver',
      name: 'Silver partner discount',
      priority: 20,
      stackable: true,
      condition: { op: 'and', terms: [{ op: 'eq', field: 'quote.channel', value: 'partner-silver' }, { op: 'eq', field: 'line.chargeType', value: 'recurring' }] },
      effect: { type: 'percent', basisPoints: 500 },
    },
    {
      id: 'multi-year',
      name: 'Multi-year commitment',
      priority: 25,
      stackable: true,
      condition: { op: 'and', terms: [{ op: 'gte', field: 'quote.termMonths', value: 36 }, { op: 'eq', field: 'line.chargeType', value: 'recurring' }] },
      effect: { type: 'percent', basisPoints: 700 },
    },
    {
      id: 'q4-promo',
      name: 'Q4 2026 platform promo',
      priority: 30,
      stackable: true,
      stackGroup: 'promo',
      condition: {
        op: 'and',
        terms: [
          { op: 'contains', field: 'quote.promoCodes', value: 'Q4-2026' },
          { op: 'eq', field: 'line.family', value: 'platform' },
          { op: 'gte', field: 'quote.asOf', value: '2026-10-01' },
          { op: 'lte', field: 'quote.asOf', value: '2026-12-31' },
        ],
      },
      effect: { type: 'percent', basisPoints: 500 },
    },
    {
      id: 'launch-promo',
      name: 'Launch promo',
      priority: 31,
      stackable: true,
      stackGroup: 'promo',
      condition: { op: 'contains', field: 'quote.promoCodes', value: 'LAUNCH' },
      effect: { type: 'percent', basisPoints: 800 },
    },
  ],
  orderDiscountRules: [
    {
      id: 'large-deal',
      name: 'Large deal order discount',
      priority: 10,
      condition: { op: 'gte', field: 'quote.subtotal', value: '250000' },
      basisPoints: 200,
    },
  ],
  floors: {
    defaultMaxDiscountBp: 4000,
    behavior: 'clamp-and-warn',
    byProduct: [
      { productId: 'plat', maxDiscountBp: 4500 },
      { productId: 'onb', minUnitPrice: '2500' },
      { productId: 'api', minUnitPrice: '0.0006' },
    ],
  },
  approvalRules: [
    {
      id: 'discount-manager',
      name: 'Discount above rep authority',
      condition: {
        op: 'or',
        terms: [
          { op: 'gt', field: 'approval.maxManualDiscountBp', value: 1000 },
          { op: 'gt', field: 'approval.totalDiscountBp', value: 2000 },
        ],
      },
      approvers: [{ type: 'manager-of', userId: 'owner', levels: 1 }],
      mode: 'sequential',
      order: 10,
      reason: 'Rep authority is 10% manual / 20% total discount',
    },
    {
      id: 'floor-clamped',
      name: 'Requested discount below floor',
      condition: { op: 'eq', field: 'approval.floorClamped', value: true },
      approvers: [{ type: 'role', role: 'deal-desk' }],
      mode: 'sequential',
      order: 12,
      reason: 'A requested discount was clamped to a pricing floor',
    },
    {
      id: 'large-deal-review',
      name: 'Large deal review',
      condition: { op: 'gte', field: 'approval.total', value: '250000' },
      approvers: [
        { type: 'role', role: 'deal-desk' },
        { type: 'role', role: 'finance' },
      ],
      mode: 'parallel',
      order: 15,
      reason: 'Total contract value ≥ $250,000',
    },
    {
      id: 'discount-vp',
      name: 'Discount above manager authority',
      condition: { op: 'gt', field: 'approval.totalDiscountBp', value: 3000 },
      approvers: [{ type: 'role', role: 'vp-sales' }],
      mode: 'sequential',
      order: 20,
      reason: 'Manager authority is 30% total discount',
    },
    {
      id: 'mega-deal',
      name: 'CFO sign-off',
      condition: { op: 'gte', field: 'approval.total', value: '1000000' },
      approvers: [{ type: 'role', role: 'cfo' }],
      mode: 'sequential',
      order: 40,
      reason: 'Total contract value ≥ $1,000,000',
    },
    {
      id: 'payment-terms',
      name: 'Non-standard payment terms',
      condition: { op: 'gt', field: 'approval.paymentNetDays', value: 30 },
      approvers: [{ type: 'role', role: 'finance' }],
      mode: 'parallel',
      order: 30,
      reason: 'Standard payment terms are net 30',
    },
    {
      id: 'legal-terms',
      name: 'Non-standard legal terms',
      condition: { op: 'neq', field: 'approval.legalTermsVersion', value: 'std-2026.1' },
      approvers: [{ type: 'role', role: 'legal' }],
      mode: 'parallel',
      order: 30,
      reason: 'Legal terms differ from the standard std-2026.1 paper',
    },
    {
      id: 'long-term',
      name: 'Term outside norm',
      condition: { op: 'gt', field: 'approval.termMonths', value: 36 },
      approvers: [{ type: 'role', role: 'finance' }],
      mode: 'sequential',
      order: 30,
      reason: 'Standard terms are 12–36 months',
    },
  ],
  nonStandardApprovers: [
    { type: 'role', role: 'deal-desk' },
    { type: 'role', role: 'cfo' },
  ],
  escalation: { afterBusinessHours: 8 },
};

export type User = { id: string; name: string; email: string; roles: string[]; managerId?: string };

export const USERS: User[] = [
  { id: 'alice', name: 'Alice Reyes', email: 'alice@example.com', roles: ['rep'], managerId: 'mike' },
  { id: 'bob', name: 'Bob Chen', email: 'bob@example.com', roles: ['rep'], managerId: 'mike' },
  { id: 'mike', name: 'Mike Okafor', email: 'mike@example.com', roles: ['sales-manager', 'rep'], managerId: 'vera' },
  { id: 'nina', name: 'Nina Park', email: 'nina@example.com', roles: ['sales-manager', 'rep'], managerId: 'vera' },
  { id: 'vera', name: 'Vera Lindqvist', email: 'vera@example.com', roles: ['vp-sales'], managerId: 'carl' },
  { id: 'carl', name: 'Carl Mendes', email: 'carl@example.com', roles: ['cfo'] },
  { id: 'dana', name: 'Dana Whitfield', email: 'dana@example.com', roles: ['deal-desk'], managerId: 'fran' },
  { id: 'fran', name: 'Fran Osei', email: 'fran@example.com', roles: ['finance'], managerId: 'carl' },
  { id: 'lee', name: 'Lee Tanaka', email: 'lee@example.com', roles: ['legal'], managerId: 'carl' },
  { id: 'priya', name: 'Priya Natarajan', email: 'priya@example.com', roles: ['pricing-owner', 'deal-desk'], managerId: 'carl' },
  { id: 'sam', name: 'Sam Kowalski', email: 'sam@example.com', roles: ['pricing-analyst'], managerId: 'priya' },
];

export type Account = {
  id: string;
  name: string;
  segment: string;
  billingAddress: { line1: string; city: string; region: string; postalCode: string; country: string };
  taxIds: Array<{ type: string; value: string }>;
  signer: { name: string; email: string; title: string };
};

export const ACCOUNTS: Account[] = [
  {
    id: 'acct-northwind',
    name: 'Northwind Logistics',
    segment: 'enterprise',
    billingAddress: { line1: '400 Harbor Way', city: 'Oakland', region: 'CA', postalCode: '94607', country: 'US' },
    taxIds: [{ type: 'us_ein', value: '12-3456789' }],
    signer: { name: 'Jordan Blake', email: 'jordan.blake@northwind.example', title: 'VP Operations' },
  },
  {
    id: 'acct-brightpath',
    name: 'Brightpath Health',
    segment: 'mid-market',
    billingAddress: { line1: '88 Alder St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' },
    taxIds: [],
    signer: { name: 'Morgan Ellis', email: 'morgan@brightpath.example', title: 'CIO' },
  },
  {
    id: 'acct-riverbend',
    name: 'Riverbend Food Bank',
    segment: 'nonprofit',
    billingAddress: { line1: '12 Mill Rd', city: 'Sacramento', region: 'CA', postalCode: '95814', country: 'US' },
    taxIds: [{ type: 'us_ein', value: '98-7654321' }],
    signer: { name: 'Casey Nguyen', email: 'casey@riverbend.example', title: 'Executive Director' },
  },
];

/** Cliffs that someone deliberately decided are acceptable (design guide §13.3). */
export const EXPECTED_CLIFFS: Array<{ productId: string; atQuantity: number; reason: string }> = [
  { productId: 'api', atQuantity: 1000000, reason: 'Volume commit break at 1M calls is intentional: drives upsell to the next commit level.' },
  { productId: 'api', atQuantity: 10000000, reason: 'Volume commit break at 10M calls is intentional.' },
];
