/**
 * Property tests over arbitrary quotes (design guide §13.2), cliff detection
 * with an allowlist (§13.3), and engine purity.
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { priceQuote } from '../src/pricing/pipeline.ts';
import { resolveFloor } from '../src/pricing/stages/floors.ts';
import { add, gte, lt, mulQty, mulRatio, rescale, sub, sum, zero, type Money, type RoundingMode } from '../src/money/money.ts';
import { serialize } from '../src/pricing/codec.ts';
import type { QuoteConfig, QuoteLineConfig, RuleSet } from '../src/pricing/types.ts';
import { EXPECTED_CLIFFS } from '../src/seed/data.ts';
import { config, PB1, RS1 } from './helpers.ts';

const sellable = PB1.entries.filter((p) => p.active && p.productId !== 'api' && p.productId !== 'sso').map((p) => p.productId);

const arbLine = (i: number): fc.Arbitrary<QuoteLineConfig> =>
  fc.record({
    productId: fc.constantFrom(...sellable, 'api'),
    qty: fc.integer({ min: 1, max: 2000 }),
    manual: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
    term: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
  }).map(({ productId, qty, manual, term }) => {
    const l: QuoteLineConfig = { lineId: `L${i}`, productId, quantity: String(productId === 'api' ? qty * 1000 : qty) };
    if (manual !== undefined) l.manualDiscountBp = manual;
    if (term !== undefined) l.termMonths = term;
    return l;
  });

const arbQuote: fc.Arbitrary<QuoteConfig> = fc
  .record({
    n: fc.integer({ min: 1, max: 5 }),
    channel: fc.constantFrom('direct', 'partner-gold', 'partner-silver'),
    segment: fc.constantFrom('enterprise', 'mid-market', 'nonprofit'),
    term: fc.integer({ min: 1, max: 60 }),
    promos: fc.subarray(['Q4-2026', 'LAUNCH']),
    orderBp: fc.option(fc.integer({ min: 0, max: 3000 }), { nil: undefined }),
    asOf: fc.constantFrom('2026-09-30', '2026-10-01', '2026-12-31', '2027-01-01'),
  })
  .chain((h) =>
    fc.tuple(...Array.from({ length: h.n }, (_, i) => arbLine(i + 1))).map((lines) => {
      // api requires plat; keep configurations valid
      const ls = lines.some((l) => l.productId === 'api') ? [...lines, { lineId: 'LP', productId: 'plat', quantity: '1' }] : lines;
      // prem and std-sup are mutually exclusive
      const cleaned = ls.some((l) => l.productId === 'prem') ? ls.filter((l) => l.productId !== 'std-sup') : ls;
      const c = config({ channel: h.channel, segment: h.segment, termMonths: h.term, promoCodes: h.promos, asOf: h.asOf, lines: cleaned });
      if (h.orderBp !== undefined) c.orderManualDiscountBp = h.orderBp;
      return c;
    }),
  );

const ruleSets: RuleSet[] = [
  RS1,
  { ...RS1, stacking: { ...RS1.stacking, mode: 'additive' } },
  { ...RS1, rounding: { mode: 'half-even', point: 'line' } },
  { ...RS1, rounding: { mode: 'down', point: 'line' } },
];

describe('pricing properties', () => {
  test('total equals the sum of line nets; nets equal extended minus order allocation', () => {
    fc.assert(
      fc.property(arbQuote, fc.constantFrom(...ruleSets), (c, rs) => {
        const p = priceQuote(c, rs, PB1);
        expect(p.total).toEqual(sum(p.lines.map((l) => l.net), 'USD', 2));
        expect(p.subtotal).toEqual(sum(p.lines.map((l) => l.extended), 'USD', 2));
        expect(p.total).toEqual(sub(p.subtotal, p.orderDiscount));
        for (const l of p.lines) expect(l.net).toEqual(sub(l.extended, l.orderDiscount));
      }),
      { numRuns: 300 },
    );
  });

  test('no line ever lands below its floor — including after order-level discounts', () => {
    fc.assert(
      fc.property(arbQuote, fc.constantFrom(...ruleSets), (c, rs) => {
        const p = priceQuote(c, rs, PB1);
        for (const l of p.lines) {
          const listExt = mulProrated(l, rs.rounding.mode);
          const { floor } = resolveFloor({ productId: l.productId, listExtended: listExt, qty: l.quantity, prorNum: pn(l), prorDen: pd(l) }, rs);
          expect(gte(l.net, rescale(floor, 2, rs.rounding.mode)), `${l.lineId} ${l.productId}`).toBe(true);
          expect(l.net.minor >= 0n).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('pricing is deterministic — byte-identical serialized output', () => {
    fc.assert(
      fc.property(arbQuote, (c) => {
        expect(serialize(priceQuote(c, RS1, PB1))).toBe(serialize(priceQuote(structuredClone(c), RS1, PB1)));
      }),
      { numRuns: 200 },
    );
  });

  test('line order in the configuration does not change any line price', () => {
    fc.assert(
      fc.property(arbQuote, (c) => {
        const a = priceQuote(c, RS1, PB1);
        const b = priceQuote({ ...c, lines: [...c.lines].reverse() }, RS1, PB1);
        const byId = (q: typeof a) => Object.fromEntries(q.lines.map((l) => [l.lineId, l.net.minor.toString()]));
        expect(byId(b)).toEqual(byId(a));
      }),
      { numRuns: 200 },
    );
  });

  test('additive stacking never gives a smaller discount than multiplicative for the same rules', () => {
    fc.assert(
      fc.property(arbQuote, (c) => {
        const m = priceQuote(c, RS1, PB1);
        const a = priceQuote(c, ruleSets[1]!, PB1);
        // compare pre-order-discount line amounts (order discount depends on subtotal thresholds)
        for (const l of a.lines) {
          const lm = m.lines.find((x) => x.lineId === l.lineId)!;
          expect(lt(lm.extended, l.extended)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  test('trace deltas reconcile to each line’s movement', () => {
    fc.assert(
      fc.property(arbQuote, (c) => {
        const p = priceQuote(c, RS1, PB1);
        for (const l of p.lines) {
          const deltas = p.trace.filter((t) => t.lineId === l.lineId && t.delta && t.stage !== 'order-level').map((t) => t.delta!);
          const total = deltas.reduce((acc: Money, d) => add(acc, d), zero('USD', 6));
          // base-price + tier + discounts + floor + rounding deltas = extended (at unit scale)
          expect(total).toEqual(rescale(l.extended, 6, 'down'));
        }
      }),
      { numRuns: 200 },
    );
  });
});

function pn(l: { chargeType: string; termMonths: number }) {
  return l.chargeType === 'recurring' ? BigInt(l.termMonths) : 1n;
}
function pd(l: { chargeType: string }) {
  return l.chargeType === 'recurring' ? 12n : 1n;
}
/** Recompute the prorated list amount exactly as the base-price stage does. */
function mulProrated(l: { listUnitPrice: Money; quantity: bigint; chargeType: string; termMonths: number }, mode: RoundingMode): Money {
  return mulRatio(mulQty(l.listUnitPrice, l.quantity), pn(l), pd(l), mode);
}

describe('tier cliffs', () => {
  test('every cliff is in the allowlist (someone deliberately decided it)', () => {
    const cliffs: Array<{ productId: string; atQuantity: number }> = [];
    const priceAt = (productId: string, qty: number) =>
      priceQuote(config({ lines: [{ lineId: 'L1', productId, quantity: String(qty) }, ...(productId === 'api' || productId === 'sso' ? [{ lineId: 'LP', productId: 'plat', quantity: '1' }] : [])] }), RS1, PB1).lines[0]!.net;
    for (const p of PB1.entries.filter((e) => e.active)) {
      const qs = new Set<number>();
      const max = p.maxTestQty ?? 50;
      if (max <= 2000) for (let q = 1; q <= max; q++) qs.add(q);
      // large ranges: scan ±3 around every band boundary
      for (const t of RS1.tiers.filter((t) => t.productId === p.productId)) for (const b of t.bands) for (let d = -3; d <= 3; d++) if (b.fromQty + d >= 1) qs.add(b.fromQty + d);
      const sorted = [...qs].sort((a, b) => a - b);
      let prev: Money | null = null;
      let prevQ = 0;
      for (const q of sorted) {
        const total = priceAt(p.productId, q);
        if (prev && q === prevQ + 1 && lt(total, prev)) cliffs.push({ productId: p.productId, atQuantity: q });
        prev = total;
        prevQ = q;
      }
    }
    expect(cliffs).toEqual(EXPECTED_CLIFFS.map(({ productId, atQuantity }) => ({ productId, atQuantity })));
  });
});

describe('engine purity', () => {
  test('packages/pricing has no clock, randomness, network or filesystem access', () => {
    const root = join(import.meta.dirname, '..', 'src', 'pricing');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.ts') && f !== 'codec.ts') files.push(p);
      }
    };
    walk(root);
    const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random/, /from 'node:/, /require\(/, /fetch\(/, /process\./, /crypto/];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const re of forbidden) expect(re.test(src), `${f} matches ${re}`).toBe(false);
    }
    expect(files.length).toBeGreaterThan(5);
  });
});
