import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted, bigint as decimal strings, no
 * undefined values. Two structurally-equal values always serialize to the
 * same bytes, which is what makes hashing meaningful.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
    return v;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || typeof x === 'function') continue;
      out[k] = normalize(x);
    }
    return out;
  }
  return undefined;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function hmacSha256Hex(secret: string, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
