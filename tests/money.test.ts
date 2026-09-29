import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  ROUNDING_MODES,
  add,
  applyDiscountBp,
  applyRate,
  bpToPercentString,
  CurrencyMismatchError,
  divRound,
  format,
  fromJSON,
  money,
  mulQty,
  parseMoney,
  percentToBp,
  rescale,
  ScaleMismatchError,
  sub,
  toDecimalString,
  toJSON,
  type Money,
  type RoundingMode,
} from '../src/money/money.ts';

const usd = (s: string, scale = 2) => parseMoney(s, 'USD', scale);

describe('Money is not a number', () => {
  test('arithmetic with plain numbers is a compile error', () => {
    const m = usd('1.00');
    // Never invoked: these lines exist for the type checker (`npm run typecheck`).
    const compileOnly = () => {
      // @ts-expect-error — Money + number must not typecheck
      const bad1: Money = add(m, 1);
      // @ts-expect-error — no operators on Money objects
      const bad2 = m + 1;
      // @ts-expect-error — a bare object is not Money (brand)
      const bad3: Money = { minor: 1n, scale: 2, currency: 'USD' };
      return [bad1, bad2, bad3];
    };
    void compileOnly;
    expect(() => add(m, 1 as unknown as Money)).toThrow();
  });

  test('currency and scale mismatches throw', () => {
    expect(() => add(usd('1'), parseMoney('1', 'EUR', 2))).toThrow(CurrencyMismatchError);
    expect(() => add(usd('1', 2), usd('1', 6))).toThrow(ScaleMismatchError);
  });
});

describe('divRound at .5 boundaries, both signs', () => {
  // value = num/den; each row: [num, den, mode, expected]
  const table: Array<[bigint, RoundingMode, bigint]> = [
    // 2.5
    [25n, 'half-up', 3n],
    [25n, 'half-down', 2n],
    [25n, 'half-even', 2n],
    [25n, 'half-away-from-zero', 3n],
    [25n, 'down', 2n],
    [25n, 'floor', 2n],
    [25n, 'ceiling', 3n],
    // 3.5
    [35n, 'half-even', 4n],
    // -2.5
    [-25n, 'half-up', -2n],
    [-25n, 'half-down', -3n],
    [-25n, 'half-even', -2n],
    [-25n, 'half-away-from-zero', -3n],
    [-25n, 'down', -2n],
    [-25n, 'floor', -3n],
    [-25n, 'ceiling', -2n],
    // -3.5
    [-35n, 'half-even', -4n],
    // 2.6 / -2.6 / 2.4 / -2.4
    [26n, 'half-down', 3n],
    [-26n, 'half-up', -3n],
    [24n, 'half-up', 2n],
    [-24n, 'half-away-from-zero', -2n],
  ];
  test.each(table)('%s/10 %s → %s', (num, mode, exp) => {
    expect(divRound(num, 10n, mode)).toBe(exp);
  });

  test('$x.xx5 → cents in every mode, both signs', () => {
    // 10.005 at scale 3 → scale 2
    const pos = parseMoney('10.005', 'USD', 3);
    const neg = parseMoney('-10.005', 'USD', 3);
    const exp: Record<RoundingMode, [string, string]> = {
      'half-up': ['10.01', '-10.00'],
      'half-down': ['10.00', '-10.01'],
      'half-even': ['10.00', '-10.00'],
      'half-away-from-zero': ['10.01', '-10.01'],
      down: ['10.00', '-10.00'],
      floor: ['10.00', '-10.01'],
      ceiling: ['10.01', '-10.00'],
    };
    for (const mode of ROUNDING_MODES) {
      expect([toDecimalString(rescale(pos, 2, mode)), toDecimalString(rescale(neg, 2, mode))]).toEqual(exp[mode]);
    }
    // 10.015 half-even goes up (1 is odd)
    expect(toDecimalString(rescale(parseMoney('10.015', 'USD', 3), 2, 'half-even'))).toBe('10.02');
  });

  test('property: result is within one unit of the true quotient and on the correct side', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 15n), 10n ** 15n), fc.bigInt(1n, 10n ** 6n), fc.constantFrom(...ROUNDING_MODES), (num, den, mode) => {
        const q = divRound(num, den, mode);
        // |q*den - num| <= den
        const err = q * den - num;
        expect(err <= den && err >= -den).toBe(true);
        if (mode === 'floor') expect(q * den <= num).toBe(true);
        if (mode === 'ceiling') expect(q * den >= num).toBe(true);
        if (mode.startsWith('half')) expect(2n * (err < 0n ? -err : err) <= den).toBe(true);
      }),
    );
  });
});

describe('rates, parsing, formatting', () => {
  test('rates are basis points', () => {
    expect(toDecimalString(applyRate(usd('100000'), 1500n, 'half-up'))).toBe('15000.00');
    expect(toDecimalString(applyDiscountBp(usd('100000'), 2000n, 'half-up'))).toBe('80000.00');
    // the $3,000 question: multiplicative 20% then 15% = 32%
    const mult = applyDiscountBp(applyDiscountBp(usd('100000'), 2000n, 'half-up'), 1500n, 'half-up');
    expect(toDecimalString(mult)).toBe('68000.00');
    expect(percentToBp('12.5')).toBe(1250);
    expect(bpToPercentString(1250)).toBe('12.5%');
  });

  test('0.1 + 0.2 === 0.3', () => {
    expect(toDecimalString(add(usd('0.1'), usd('0.2')))).toBe('0.30');
  });

  test('parse refuses silent truncation', () => {
    expect(() => usd('10.005')).toThrow(RangeError);
    expect(() => usd('1e5')).toThrow(SyntaxError);
    expect(toDecimalString(parseMoney('0.0012', 'USD', 6))).toBe('0.001200');
  });

  test('ISO 4217 minor units', () => {
    expect(format(parseMoney('1234', 'JPY', 0))).toBe('¥1,234');
    expect(format(parseMoney('1.234', 'KWD', 3))).toBe('KD 1.234');
    expect(format(parseMoney('-0.0012', 'USD', 6))).toBe('−$0.0012');
  });

  test('round-trips through JSON exactly', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 20n), 10n ** 20n), fc.integer({ min: 0, max: 8 }), (minor, scale) => {
        const m = money(minor, 'USD', scale);
        expect(fromJSON(toJSON(m))).toEqual(m);
        expect(parseMoney(toDecimalString(m), 'USD', scale)).toEqual(m);
      }),
    );
  });

  test('multiply-then-round vs round-then-multiply is a real difference', () => {
    const unit = parseMoney('10.005', 'USD', 6);
    const roundThenMultiply = mulQty(rescale(unit, 2, 'half-up'), 1000n);
    const multiplyThenRound = rescale(mulQty(unit, 1000n), 2, 'half-up');
    expect(toDecimalString(roundThenMultiply)).toBe('10010.00');
    expect(toDecimalString(multiplyThenRound)).toBe('10005.00');
    expect(toDecimalString(sub(roundThenMultiply, multiplyThenRound))).toBe('5.00');
  });
});
