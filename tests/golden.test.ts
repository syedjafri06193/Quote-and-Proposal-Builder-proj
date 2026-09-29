/**
 * Golden fixtures (design guide §13.1). Each expected value is hand-computed
 * in the fixture's description. A diff in a golden file is a pricing change
 * and must be reviewed as one.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { priceQuote } from '../src/pricing/pipeline.ts';
import { toDecimalString } from '../src/money/money.ts';
import type { QuoteConfig, RuleSet } from '../src/pricing/types.ts';
import { config, PB1, RS1 } from './helpers.ts';
import { validateRuleSet } from '../src/rules/validate.ts';
import { USERS } from '../src/seed/data.ts';

type Fixture = {
  description: string;
  ruleSetOverrides?: Partial<RuleSet>;
  config: Partial<QuoteConfig>;
  expected: {
    total: string;
    subtotal?: string;
    orderDiscount?: string;
    lines: Record<string, string>;
    floorClamped?: boolean;
    appliedRules?: Record<string, string[]>;
  };
};

const dir = join(import.meta.dirname, 'golden');
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture] as const);

describe('golden fixtures', () => {
  test.each(fixtures)('%s', (_name, fx) => {
    const rs: RuleSet = { ...structuredClone(RS1), ...(fx.ruleSetOverrides ?? {}) };
    const v = validateRuleSet(rs, { priceBook: PB1, roles: new Set(USERS.flatMap((u) => u.roles)), userIds: new Set(USERS.map((u) => u.id)) });
    expect(v.errors, 'fixture rule set must validate').toEqual([]);
    const q = priceQuote(config(fx.config), rs, PB1);
    expect(toDecimalString(q.total)).toBe(fx.expected.total);
    if (fx.expected.subtotal) expect(toDecimalString(q.subtotal)).toBe(fx.expected.subtotal);
    if (fx.expected.orderDiscount) expect(toDecimalString(q.orderDiscount)).toBe(fx.expected.orderDiscount);
    for (const [lineId, net] of Object.entries(fx.expected.lines)) {
      expect(toDecimalString(q.lines.find((l) => l.lineId === lineId)!.net), lineId).toBe(net);
    }
    if (fx.expected.floorClamped !== undefined) expect(q.floorClamped).toBe(fx.expected.floorClamped);
    for (const [lineId, rules] of Object.entries(fx.expected.appliedRules ?? {})) {
      expect(q.lines.find((l) => l.lineId === lineId)!.appliedRuleIds).toEqual(rules);
    }
  });

  test('there is a fixture for every tier boundary and rounding mode edge we care about', () => {
    const names = fixtures.map(([n]) => n);
    for (const n of ['graduated_tier_boundary_99', 'graduated_tier_boundary_100', 'graduated_tier_boundary_101', 'rounding_half-up_edge', 'floor_clamp_triggered'])
      expect(names).toContain(n);
  });
});
