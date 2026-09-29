import { describe, expect, test } from 'vitest';
import { evaluate, validateCondition, referencedFields, describeCondition, type Condition } from '../src/pricing/conditions.ts';

describe('constrained conditions', () => {
  const ctx = {
    'line.productId': 'plat',
    'line.quantity': 150n,
    'quote.promoCodes': ['LAUNCH', 'Q4-2026'],
    'quote.asOf': '2026-10-05',
    'approval.total': '250000.00',
    'approval.floorClamped': false,
  };

  test('evaluates comparisons, sets, dates and exact money', () => {
    const c: Condition = {
      op: 'and',
      terms: [
        { op: 'eq', field: 'line.productId', value: 'plat' },
        { op: 'gte', field: 'line.quantity', value: 100 },
        { op: 'contains', field: 'quote.promoCodes', value: 'Q4-2026' },
        { op: 'gte', field: 'quote.asOf', value: '2026-10-01' },
        { op: 'not', term: { op: 'eq', field: 'approval.floorClamped', value: true } },
      ],
    };
    expect(evaluate(c, ctx)).toBe(true);
    // money compared exactly, not as floats
    expect(evaluate({ op: 'gte', field: 'approval.total', value: '250000' }, ctx)).toBe(true);
    expect(evaluate({ op: 'gt', field: 'approval.total', value: '250000.001' }, ctx)).toBe(false);
    expect(evaluate({ op: 'in', field: 'line.productId', values: ['sso', 'plat'] }, ctx)).toBe(true);
    expect(evaluate({ op: 'or', terms: [{ op: 'lt', field: 'line.quantity', value: 10 }] }, ctx)).toBe(false);
  });

  test('static validation catches typos, wrong types and wrong scopes', () => {
    expect(validateCondition({ op: 'eq', field: 'line.prodId', value: 'x' }, ['line'])).toEqual([expect.stringContaining('unknown field "line.prodId"')]);
    expect(validateCondition({ op: 'gte', field: 'line.quantity', value: '100' }, ['line'])[0]).toContain('not a valid int');
    expect(validateCondition({ op: 'eq', field: 'approval.total', value: 5 }, ['line', 'quote'])[0]).toContain('not available here');
    expect(validateCondition({ op: 'eval', code: 'process.exit()' }, ['line'])[0]).toContain('unknown operator');
    expect(validateCondition({ op: 'gt', field: 'approval.floorClamped', value: true }, ['approval'])[0]).toContain('only eq/neq');
    expect(validateCondition({ op: 'and', terms: [] }, ['line'])[0]).toContain('non-empty');
    expect(validateCondition({ op: 'contains', field: 'quote.promoCodes', value: 'X' }, ['quote'])).toEqual([]);
  });

  test('is analyzable without executing', () => {
    const c: Condition = { op: 'or', terms: [{ op: 'eq', field: 'quote.channel', value: 'x' }, { op: 'gt', field: 'line.quantity', value: 1 }] };
    expect(referencedFields(c)).toEqual(['line.quantity', 'quote.channel']);
    expect(describeCondition(c)).toBe('(quote.channel = "x" OR line.quantity > 1)');
  });
});
