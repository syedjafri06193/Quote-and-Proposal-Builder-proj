/**
 * Structured contract output for downstream billing, provisioning and revenue
 * recognition (design guide §11). The PDF is for humans; this is for systems.
 */
import { divRound, toDecimalString } from '../money/money.ts';
import type { PricedQuote, QuoteConfig, BillingFrequency, RecognitionMethod } from '../pricing/types.ts';
import type { Account } from '../seed/data.ts';

export type ExecutedContract = {
  schemaVersion: '1.0';
  contractId: string;
  quoteId: string;
  quoteNumber: number;
  quoteVersion: number;
  documentHash: string;
  contentHash: string;
  executedAt: string;
  currency: string;
  customer: {
    accountId: string;
    name: string;
    billingAddress: Account['billingAddress'];
    taxIds: Account['taxIds'];
  };
  term: { startDate: string; endDate: string; months: number; autoRenew: boolean; noticePeriodDays: number };
  lines: Array<{
    lineId: string;
    productId: string;
    sku: string;
    description: string;
    quantity: string;
    unitPriceMinorUnits: string;
    unitPriceScale: number;
    extendedMinorUnits: string;
    discountBasisPoints: number;
    billingFrequency: BillingFrequency;
    recognitionMethod: RecognitionMethod;
    standaloneSellingPriceMinorUnits: string;
    serviceStartDate: string;
    serviceEndDate: string;
  }>;
  paymentTerms: { netDays: number; method: string };
  totalMinorUnits: string;
  totalDecimal: string;
  minorUnitScale: number;
  ruleSetVersion: number;
  priceBookVersion: number;
  nonStandard: boolean;
  approvals: Array<{ approverId: string; role: string; decision: string; conditions: string | null; decidedAt: string }>;
};

/** Calendar arithmetic on YYYY-MM-DD, whole-month convention (design guide §3.5). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
/** Term end: the day before start + N months (a 12-month term from 2026-11-01 ends 2027-10-31). */
export function termEnd(start: string, months: number): string {
  return addDays(addMonths(start, months), -1);
}

export function buildExecutedContract(args: {
  contractId: string;
  quoteId: string;
  quoteNumber: number;
  quoteVersion: number;
  documentHash: string;
  contentHash: string;
  executedAt: string;
  priced: PricedQuote;
  config: QuoteConfig;
  account: Account;
  approvals: ExecutedContract['approvals'];
}): ExecutedContract {
  const { priced: q, config: c } = args;
  const start = q.startDate;
  return {
    schemaVersion: '1.0',
    contractId: args.contractId,
    quoteId: args.quoteId,
    quoteNumber: args.quoteNumber,
    quoteVersion: args.quoteVersion,
    documentHash: args.documentHash,
    contentHash: args.contentHash,
    executedAt: args.executedAt,
    currency: q.currency,
    customer: {
      accountId: args.account.id,
      name: args.account.name,
      billingAddress: args.account.billingAddress,
      taxIds: args.account.taxIds,
    },
    term: { startDate: start, endDate: termEnd(start, q.termMonths), months: q.termMonths, autoRenew: c.autoRenew, noticePeriodDays: c.noticePeriodDays },
    lines: q.lines.map((l) => {
      // SSP for the whole line on the same basis as the price: unit SSP × qty × proration.
      const prorNum = l.chargeType === 'recurring' ? BigInt(l.termMonths) : 1n;
      const prorDen = l.chargeType === 'recurring' ? 12n : 1n;
      const scaleDiff = 10n ** BigInt(l.sspUnitPrice.scale - l.net.scale);
      const sspLine = divRound(l.sspUnitPrice.minor * l.quantity * prorNum, prorDen * scaleDiff, 'half-up');
      return {
        lineId: l.lineId,
        productId: l.productId,
        sku: l.sku,
        description: l.description || l.name,
        quantity: l.quantity.toString(),
        unitPriceMinorUnits: l.unitPrice.minor.toString(),
        unitPriceScale: l.unitPrice.scale,
        extendedMinorUnits: l.net.minor.toString(),
        discountBasisPoints: l.totalDiscountBasisPoints,
        billingFrequency: l.billingFrequency,
        recognitionMethod: l.recognitionMethod,
        standaloneSellingPriceMinorUnits: sspLine.toString(),
        serviceStartDate: start,
        serviceEndDate: l.chargeType === 'recurring' ? termEnd(start, l.termMonths) : start,
      };
    }),
    paymentTerms: { ...q.paymentTerms },
    totalMinorUnits: q.total.minor.toString(),
    totalDecimal: toDecimalString(q.total),
    minorUnitScale: q.total.scale,
    ruleSetVersion: q.ruleSetVersion,
    priceBookVersion: q.priceBookVersion,
    nonStandard: q.quoteType === 'non-standard',
    approvals: args.approvals,
  };
}

/** Structural validation a downstream consumer can run on ingest. */
export function validateExecutedContract(c: ExecutedContract): string[] {
  const errs: string[] = [];
  const intStr = /^-?\d+$/;
  if (c.schemaVersion !== '1.0') errs.push('schemaVersion');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.term.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(c.term.endDate)) errs.push('term dates');
  if (!intStr.test(c.totalMinorUnits)) errs.push('totalMinorUnits');
  let sum = 0n;
  for (const l of c.lines) {
    for (const k of ['quantity', 'unitPriceMinorUnits', 'extendedMinorUnits', 'standaloneSellingPriceMinorUnits'] as const)
      if (!intStr.test(l[k])) errs.push(`${l.lineId}.${k}`);
    if (!l.billingFrequency || !l.recognitionMethod) errs.push(`${l.lineId}: billing/recognition`);
    if (l.serviceEndDate < l.serviceStartDate) errs.push(`${l.lineId}: service dates`);
    sum += BigInt(l.extendedMinorUnits);
  }
  if (sum.toString() !== c.totalMinorUnits) errs.push('lines do not sum to total');
  return errs;
}
