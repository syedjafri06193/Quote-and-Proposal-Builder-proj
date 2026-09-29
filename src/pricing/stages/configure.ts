import { SCALE_UNIT, parseMoney, mulQty, zero } from '../../money/money.ts';
import { PricingError, type PriceBookEntry, type TraceEntry } from '../types.ts';
import { type LineState, type Stage, cloneState, prorate, fmt } from '../state.ts';

const INT_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * configure: validate the configuration against the pinned price book and
 * build line state. Catalog data quality is a gate, not a warning.
 */
export const configure: Stage = {
  name: 'configure',
  run(input, rs) {
    const s = cloneState(input);
    const c = s.config;
    const issues: string[] = [];
    const trace: TraceEntry[] = [];

    if (c.currency !== rs.currency) issues.push(`quote currency ${c.currency} ≠ rule set currency ${rs.currency}`);
    if (c.currency !== s.priceBook.currency) issues.push(`quote currency ${c.currency} ≠ price book currency ${s.priceBook.currency}`);
    if (!DATE_RE.test(c.asOf)) issues.push(`asOf must be YYYY-MM-DD`);
    if (!DATE_RE.test(c.startDate)) issues.push(`startDate must be YYYY-MM-DD`);
    if (!Number.isInteger(c.termMonths) || c.termMonths < 1 || c.termMonths > 120) issues.push('termMonths must be an integer 1–120');
    if (!Number.isInteger(c.paymentTerms.netDays) || c.paymentTerms.netDays < 0 || c.paymentTerms.netDays > 365)
      issues.push('paymentTerms.netDays must be an integer 0–365');
    if (c.lines.length === 0) issues.push('a quote needs at least one line');
    if (c.orderManualDiscountBp !== undefined && !validBp(c.orderManualDiscountBp)) issues.push('orderManualDiscountBp must be 0–10000');
    if (s.nonStandard && !c.nonStandardReason?.trim()) issues.push('non-standard quotes require a reason');

    const byId = new Map<string, PriceBookEntry>(s.priceBook.entries.map((e) => [e.productId, e]));
    const seen = new Set<string>();
    const lines: LineState[] = [];

    for (const l of c.lines) {
      const where = `line ${l.lineId || '?'}`;
      if (!l.lineId) issues.push('every line needs a lineId');
      if (seen.has(l.lineId)) issues.push(`${where}: duplicate lineId`);
      seen.add(l.lineId);
      if (!INT_RE.test(l.quantity) || BigInt(l.quantity) < 1n) {
        issues.push(`${where}: quantity must be a positive integer`);
        continue;
      }
      if (l.manualDiscountBp !== undefined && !validBp(l.manualDiscountBp)) issues.push(`${where}: manualDiscountBp must be 0–10000`);

      let entry: PriceBookEntry | null = null;
      let listUnitStr: string;
      let sspStr: string;
      let chargeType = l.chargeType ?? 'one-time';
      let meta = { sku: 'CUSTOM', name: l.description ?? 'Custom item', family: 'custom', description: l.description ?? '' };
      let billing: LineState['billingFrequency'] = chargeType === 'recurring' ? 'annual' : 'one-time';
      let recog: LineState['recognitionMethod'] = chargeType === 'recurring' ? 'ratable' : 'point-in-time';

      if (s.nonStandard && l.manualUnitPrice !== undefined) {
        if (!l.description?.trim()) issues.push(`${where}: non-standard lines need a description`);
        listUnitStr = l.manualUnitPrice;
        sspStr = l.manualUnitPrice;
        entry = byId.get(l.productId) ?? null;
        if (entry) {
          chargeType = entry.chargeType;
          meta = { sku: entry.sku, name: entry.name, family: entry.family, description: l.description ?? entry.description };
          billing = entry.billingFrequency;
          recog = entry.recognitionMethod;
        }
      } else {
        if (l.manualUnitPrice !== undefined) issues.push(`${where}: manual prices are only allowed on non-standard quotes`);
        entry = byId.get(l.productId) ?? null;
        if (!entry) {
          issues.push(`${where}: product ${l.productId} is not in price book v${s.priceBook.version}`);
          continue;
        }
        if (!entry.active) issues.push(`${where}: product ${entry.sku} is inactive`);
        listUnitStr = entry.listPrice;
        sspStr = entry.ssp ?? entry.listPrice;
        chargeType = entry.chargeType;
        meta = { sku: entry.sku, name: entry.name, family: entry.family, description: l.description ?? entry.description };
        billing = entry.billingFrequency;
        recog = entry.recognitionMethod;
      }

      const termMonths = chargeType === 'recurring' ? (l.termMonths ?? c.termMonths) : 0;
      if (chargeType === 'recurring' && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120))
        issues.push(`${where}: termMonths must be 1–120`);

      let listUnit;
      let sspUnit;
      try {
        listUnit = parseMoney(listUnitStr, c.currency, SCALE_UNIT);
        sspUnit = parseMoney(sspStr, c.currency, SCALE_UNIT);
      } catch (e) {
        issues.push(`${where}: invalid price — ${(e as Error).message}`);
        continue;
      }
      if (listUnit.minor < 0n) issues.push(`${where}: unit price cannot be negative`);

      const qty = BigInt(l.quantity);
      const z = zero(c.currency, SCALE_UNIT);
      lines.push({
        cfg: l,
        entry,
        lineId: l.lineId,
        productId: l.productId,
        ...meta,
        chargeType,
        billingFrequency: billing,
        recognitionMethod: recog,
        qty,
        termMonths,
        prorNum: chargeType === 'recurring' ? BigInt(termMonths) : 1n,
        prorDen: chargeType === 'recurring' ? 12n : 1n,
        listUnit,
        sspUnit,
        listExtended: z,
        tierAmount: z,
        amount: z,
        floor: z,
        manualBp: l.manualDiscountBp ?? 0,
        appliedRuleIds: [],
        floorClamped: false,
        warnings: [],
        extended: null,
        orderDiscount: null,
        net: null,
      });
    }

    // requires / excludes across the configuration
    if (!s.nonStandard) {
      const present = new Set(lines.map((l) => l.productId));
      for (const l of lines) {
        for (const r of l.entry?.requires ?? []) if (!present.has(r)) issues.push(`${l.sku} requires product ${r}`);
        for (const x of l.entry?.excludes ?? []) if (present.has(x)) issues.push(`${l.sku} cannot be sold with product ${x}`);
      }
    }

    if (issues.length) throw new PricingError(`configuration invalid: ${issues[0]}`, issues);

    s.lines = lines;
    trace.push({
      stage: 'configure',
      explanation: `${lines.length} line(s) validated against price book v${s.priceBook.version}, rule set v${rs.version}` +
        (s.nonStandard ? ' — NON-STANDARD quote: manual prices, rules not applied' : ''),
      inputs: { priceBookVersion: s.priceBook.version, ruleSetVersion: rs.version, quoteType: c.quoteType },
    });
    return { state: s, trace };
  },
};

function validBp(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 10_000;
}

/** basePrice: list price from the pinned price book, × quantity, × term/12 for recurring. */
export const basePrice: Stage = {
  name: 'base-price',
  run(input) {
    const s = cloneState(input);
    const trace: TraceEntry[] = [];
    for (const l of s.lines) {
      const ext = prorate(l, mulQty(l.listUnit, l.qty), s.mode);
      l.listExtended = ext;
      l.tierAmount = ext;
      l.amount = ext;
      trace.push({
        stage: 'base-price',
        lineId: l.lineId,
        before: zero(s.currency, ext.scale),
        after: ext,
        delta: ext,
        explanation:
          `${s.nonStandard ? 'manual price' : 'list price'} ${fmt(l.listUnit)}${l.chargeType === 'recurring' ? '/yr' : ''} × ${l.qty}` +
          (l.chargeType === 'recurring' ? ` × ${l.termMonths}/12 months` : ''),
        inputs: { quantity: l.qty.toString(), termMonths: l.termMonths, chargeType: l.chargeType },
      });
    }
    return { state: s, trace };
  },
};
