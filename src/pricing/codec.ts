/**
 * Exact JSON codec for engine values. Money and bigint are tagged so a
 * materialized quote round-trips to a structurally identical value — the
 * property the replay test depends on.
 */
import { money, type Currency, type Money } from '../money/money.ts';
import { canonicalJson } from '../util/hash.ts';

function isMoney(v: unknown): v is Money {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Money).minor === 'bigint' &&
    typeof (v as Money).scale === 'number' &&
    typeof (v as Money).currency === 'string'
  );
}

export function encode(v: unknown): unknown {
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (isMoney(v)) return { $m: `${v.minor}:${v.scale}:${v.currency}` };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = encode(x);
    return o;
  }
  return v;
}

export function decode<T>(v: unknown): T {
  return dec(v) as T;
}
function dec(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$b === 'string') return BigInt(o.$b);
    if (keys.length === 1 && typeof o.$m === 'string') {
      const [minor = '0', scale = '0', cur = 'USD'] = o.$m.split(':');
      return money(BigInt(minor), cur as Currency, Number(scale));
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = dec(o[k]);
    return out;
  }
  return v;
}

/** Stable serialized form for storage and hashing. */
export function serialize(v: unknown): string {
  return canonicalJson(encode(v));
}

export function deserialize<T>(s: string): T {
  return decode<T>(JSON.parse(s));
}

/**
 * API-facing form: Money becomes { amount: "123.45", minor, scale, currency },
 * bigint becomes a string. One-way; used only for responses.
 */
export function toApi(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (isMoney(v)) {
    const neg = v.minor < 0n;
    const a = (neg ? -v.minor : v.minor).toString().padStart(v.scale + 1, '0');
    const amount = (neg ? '-' : '') + (v.scale ? `${a.slice(0, -v.scale)}.${a.slice(-v.scale)}` : a);
    return { amount, minor: v.minor.toString(), scale: v.scale, currency: v.currency };
  }
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (Array.isArray(v)) return v.map(toApi);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = toApi(x);
    return o;
  }
  return v;
}
