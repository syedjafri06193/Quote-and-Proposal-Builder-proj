/**
 * Exact money arithmetic (design guide §5).
 *
 * - Amounts are integer minor units (bigint) at an explicit scale.
 * - `Money` is a branded object type: there is no way to add a plain `number`
 *   to it, and no arithmetic operators work on it. All arithmetic goes through
 *   the helpers below.
 * - Every operation that can lose precision takes an explicit RoundingMode.
 *   There is no default anywhere in this module.
 * - Currency travels with every amount and is asserted on every binary op.
 * - Rates are basis points (10000 bp = 100%).
 */

declare const MoneyBrand: unique symbol;

export type Currency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'KWD';

/** ISO 4217 minor-unit exponents. Not every currency has 2 decimals. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<Currency, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
};

/** Scale used for unit prices and in-flight pipeline amounts. */
export const SCALE_UNIT = 6;

export type RoundingMode =
  | 'half-up' // ties toward +infinity
  | 'half-down' // ties toward -infinity
  | 'half-even' // banker's rounding
  | 'half-away-from-zero'
  | 'down' // truncate toward zero
  | 'floor' // toward -infinity
  | 'ceiling'; // toward +infinity

export const ROUNDING_MODES: readonly RoundingMode[] = [
  'half-up',
  'half-down',
  'half-even',
  'half-away-from-zero',
  'down',
  'floor',
  'ceiling',
];

export type Money = {
  readonly [MoneyBrand]: true;
  readonly minor: bigint;
  readonly scale: number;
  readonly currency: Currency;
};

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class ScaleMismatchError extends Error {
  constructor(a: number, b: number) {
    super(`scale mismatch: ${a} vs ${b} — rescale explicitly first`);
    this.name = 'ScaleMismatchError';
  }
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError(`invalid scale ${scale}`);
  }
}

export function money(minor: bigint, currency: Currency, scale: number): Money {
  assertScale(scale);
  if (typeof minor !== 'bigint') throw new TypeError('money() requires a bigint');
  return Object.freeze({ minor, scale, currency }) as Money;
}

export function zero(currency: Currency, scale: number): Money {
  return money(0n, currency, scale);
}

/** Total scale for a currency (ISO 4217 minor units). */
export function totalScale(currency: Currency): number {
  return CURRENCY_MINOR_UNITS[currency];
}

const pow10Cache = new Map<number, bigint>();
export function pow10(n: number): bigint {
  let v = pow10Cache.get(n);
  if (v === undefined) {
    v = 10n ** BigInt(n);
    pow10Cache.set(n, v);
  }
  return v;
}

/**
 * Integer division with explicit rounding. `den` must be positive.
 */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den <= 0n) throw new RangeError('divRound: denominator must be positive');
  const q = num / den; // truncates toward zero
  const r = num % den; // same sign as num
  if (r === 0n) return q;
  const neg = num < 0n;
  const absR = r < 0n ? -r : r;
  const twice = absR * 2n;
  // q is the truncated value; "away" means one more unit away from zero.
  const away = neg ? q - 1n : q + 1n;
  switch (mode) {
    case 'down':
      return q;
    case 'floor':
      return neg ? q - 1n : q;
    case 'ceiling':
      return neg ? q : q + 1n;
    case 'half-away-from-zero':
      return twice >= den ? away : q;
    case 'half-up':
      // ties toward +inf: for positive, tie goes away; for negative, tie goes to q (toward zero = up)
      if (twice > den) return away;
      if (twice < den) return q;
      return neg ? q : away;
    case 'half-down':
      if (twice > den) return away;
      if (twice < den) return q;
      return neg ? away : q;
    case 'half-even': {
      if (twice > den) return away;
      if (twice < den) return q;
      const qEven = (q < 0n ? -q : q) % 2n === 0n;
      return qEven ? q : away;
    }
    default: {
      const never: never = mode;
      throw new Error(`unknown rounding mode ${String(never)}`);
    }
  }
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  if (a.scale !== b.scale) throw new ScaleMismatchError(a.scale, b.scale);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return money(a.minor + b.minor, a.currency, a.scale);
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return money(a.minor - b.minor, a.currency, a.scale);
}

export function neg(a: Money): Money {
  return money(-a.minor, a.currency, a.scale);
}

export function sum(items: readonly Money[], currency: Currency, scale: number): Money {
  let acc = zero(currency, scale);
  for (const m of items) acc = add(acc, m);
  return acc;
}

/** Multiply by an integer quantity. Exact; no rounding needed. */
export function mulQty(a: Money, qty: bigint): Money {
  return money(a.minor * qty, a.currency, a.scale);
}

/** Multiply by a ratio num/den with explicit rounding. */
export function mulRatio(a: Money, num: bigint, den: bigint, mode: RoundingMode): Money {
  return money(divRound(a.minor * num, den, mode), a.currency, a.scale);
}

/** a × (bp / 10000). */
export function applyRate(a: Money, bp: bigint, mode: RoundingMode): Money {
  return mulRatio(a, bp, 10_000n, mode);
}

/** a × (1 − bp/10000): the amount remaining after a percentage discount. */
export function applyDiscountBp(a: Money, bp: bigint, mode: RoundingMode): Money {
  return mulRatio(a, 10_000n - bp, 10_000n, mode);
}

/** Change scale. Increasing scale is exact; decreasing requires a mode. */
export function rescale(a: Money, scale: number, mode: RoundingMode): Money {
  assertScale(scale);
  if (scale === a.scale) return a;
  if (scale > a.scale) return money(a.minor * pow10(scale - a.scale), a.currency, scale);
  return money(divRound(a.minor, pow10(a.scale - scale), mode), a.currency, scale);
}

/** Exact upscale; throws if called to reduce scale. */
export function upscale(a: Money, scale: number): Money {
  if (scale < a.scale) throw new ScaleMismatchError(a.scale, scale);
  return rescale(a, scale, 'down');
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}
export const lt = (a: Money, b: Money): boolean => cmp(a, b) < 0;
export const lte = (a: Money, b: Money): boolean => cmp(a, b) <= 0;
export const gt = (a: Money, b: Money): boolean => cmp(a, b) > 0;
export const gte = (a: Money, b: Money): boolean => cmp(a, b) >= 0;
export const eq = (a: Money, b: Money): boolean => cmp(a, b) === 0;
export const isZero = (a: Money): boolean => a.minor === 0n;
export const maxMoney = (a: Money, b: Money): Money => (gte(a, b) ? a : b);
export const minMoney = (a: Money, b: Money): Money => (lte(a, b) ? a : b);

/**
 * Discount of `discounted` relative to `reference`, in basis points,
 * rounded explicitly. Returns 0 if reference is zero.
 */
export function discountBp(reference: Money, discounted: Money, mode: RoundingMode): number {
  same(reference, discounted);
  if (reference.minor === 0n) return 0;
  const bp = divRound((reference.minor - discounted.minor) * 10_000n, reference.minor < 0n ? -reference.minor : reference.minor, mode);
  return Number(bp);
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string ("10.005") into Money at `scale`.
 * Throws if the value has more precision than the scale allows — silent
 * truncation of an input price is never acceptable.
 */
export function parseMoney(s: string, currency: Currency, scale: number): Money {
  const m = DECIMAL_RE.exec(s.trim());
  if (!m) throw new SyntaxError(`invalid decimal amount: ${JSON.stringify(s)}`);
  const [, sign, intPart = '0', fracRaw = ''] = m;
  const frac = fracRaw.replace(/0+$/, '');
  if (frac.length > scale) {
    throw new RangeError(`${s} has more than ${scale} decimal places`);
  }
  const minor = BigInt(intPart) * pow10(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
  return money(sign ? -minor : minor, currency, scale);
}

/** Exact decimal string, e.g. "10.005000". */
export function toDecimalString(a: Money): string {
  const negative = a.minor < 0n;
  const abs = negative ? -a.minor : a.minor;
  if (a.scale === 0) return (negative ? '-' : '') + abs.toString();
  const p = pow10(a.scale);
  const int = abs / p;
  const frac = (abs % p).toString().padStart(a.scale, '0');
  return `${negative ? '-' : ''}${int}.${frac}`;
}

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', KWD: 'KD ' };

/**
 * Display formatting. Shows at least the currency's minor units, and more
 * only if the amount actually has non-zero sub-minor digits (e.g. $0.0012).
 */
export function format(a: Money): string {
  const minUnits = CURRENCY_MINOR_UNITS[a.currency];
  let s = toDecimalString(a);
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  let [int = '0', frac = ''] = s.split('.');
  frac = frac.replace(/0+$/, '');
  if (frac.length < minUnits) frac = frac.padEnd(minUnits, '0');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${SYMBOLS[a.currency]}${int}${frac ? '.' + frac : ''}`;
}

/** Serialization for JSON storage — strings keep exactness. */
export type MoneyJSON = { minor: string; scale: number; currency: Currency };

export function toJSON(a: Money): MoneyJSON {
  return { minor: a.minor.toString(), scale: a.scale, currency: a.currency };
}

export function fromJSON(j: MoneyJSON): Money {
  return money(BigInt(j.minor), j.currency, j.scale);
}

/** Parse basis points from a percent string like "15" or "12.5" (→ 1250). */
export function percentToBp(p: string): number {
  const m = DECIMAL_RE.exec(p.trim());
  if (!m) throw new SyntaxError(`invalid percent ${p}`);
  const [, sign, i = '0', f = ''] = m;
  if (f.replace(/0+$/, '').length > 2) throw new RangeError(`percent ${p} finer than 1 bp`);
  const bp = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return sign ? -bp : bp;
}

export function bpToPercentString(bp: number): string {
  const neg = bp < 0;
  const a = Math.abs(bp);
  const whole = Math.trunc(a / 100);
  const frac = (a % 100).toString().padStart(2, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}%`;
}
