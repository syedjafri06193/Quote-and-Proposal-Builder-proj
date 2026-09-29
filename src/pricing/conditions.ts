/**
 * The constrained condition language (design guide §6.3, §18.2).
 *
 * A condition is a small expression tree over a fixed set of known fields.
 * No eval, no user code. Conditions are validated statically at publish
 * time, so a typo'd field or a type mismatch can never reach a real quote.
 */

export type Scope = 'line' | 'quote' | 'approval';
export type FieldType = 'string' | 'int' | 'money' | 'date' | 'bool' | 'stringSet';
export type Literal = string | number | boolean;

export type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export type Condition =
  | { op: 'true' }
  | { op: 'and'; terms: Condition[] }
  | { op: 'or'; terms: Condition[] }
  | { op: 'not'; term: Condition }
  | { op: CompareOp; field: string; value: Literal }
  | { op: 'in'; field: string; values: Literal[] }
  /** Set membership for stringSet fields: the field contains `value`. */
  | { op: 'contains'; field: string; value: string };

export type FieldDef = { type: FieldType; scope: Scope; description: string };

/** Every field a rule may reference. Adding a field is a code change, deliberately. */
export const FIELDS: Readonly<Record<string, FieldDef>> = {
  'line.productId': { type: 'string', scope: 'line', description: 'Product id' },
  'line.sku': { type: 'string', scope: 'line', description: 'SKU' },
  'line.family': { type: 'string', scope: 'line', description: 'Product family' },
  'line.chargeType': { type: 'string', scope: 'line', description: 'recurring | one-time' },
  'line.quantity': { type: 'int', scope: 'line', description: 'Line quantity' },
  'line.termMonths': { type: 'int', scope: 'line', description: 'Line term in months' },

  'quote.accountId': { type: 'string', scope: 'quote', description: 'Customer account' },
  'quote.segment': { type: 'string', scope: 'quote', description: 'smb | mid-market | enterprise' },
  'quote.channel': { type: 'string', scope: 'quote', description: 'direct | partner-gold | partner-silver' },
  'quote.promoCodes': { type: 'stringSet', scope: 'quote', description: 'Promo codes on the quote' },
  'quote.asOf': { type: 'date', scope: 'quote', description: 'Pricing date (YYYY-MM-DD)' },
  'quote.termMonths': { type: 'int', scope: 'quote', description: 'Quote term in months' },
  'quote.quoteType': { type: 'string', scope: 'quote', description: 'standard | non-standard' },
  'quote.paymentNetDays': { type: 'int', scope: 'quote', description: 'Payment terms, net days' },
  'quote.subtotal': { type: 'money', scope: 'quote', description: 'Sum of line amounts before order discounts (order rules only)' },

  'approval.total': { type: 'money', scope: 'approval', description: 'Total contract value' },
  'approval.totalDiscountBp': { type: 'int', scope: 'approval', description: 'Total discount vs list, bp' },
  'approval.maxLineDiscountBp': { type: 'int', scope: 'approval', description: 'Largest line discount vs list, bp' },
  'approval.maxManualDiscountBp': { type: 'int', scope: 'approval', description: 'Largest rep-entered discount, bp' },
  'approval.floorClamped': { type: 'bool', scope: 'approval', description: 'Any line clamped to a floor' },
  'approval.nonStandard': { type: 'bool', scope: 'approval', description: 'Non-standard deal' },
  'approval.paymentNetDays': { type: 'int', scope: 'approval', description: 'Payment terms, net days' },
  'approval.termMonths': { type: 'int', scope: 'approval', description: 'Quote term in months' },
  'approval.legalTermsVersion': { type: 'string', scope: 'approval', description: 'Legal terms version' },
  'approval.segment': { type: 'string', scope: 'approval', description: 'Customer segment' },
};

/** Values the evaluator sees. Money is carried as an exact decimal string + scale-free compare. */
export type EvalValue = string | number | boolean | bigint | readonly string[];
export type EvalContext = Readonly<Record<string, EvalValue | undefined>>;

export class ConditionError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Compare two exact decimal strings without floating point. */
export function compareDecimal(a: string, b: string): number {
  const [ai, af] = splitDec(a);
  const [bi, bf] = splitDec(b);
  const len = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(len, '0'));
  const y = BigInt(bi + bf.padEnd(len, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
function splitDec(s: string): [string, string] {
  const [i = '0', f = ''] = s.split('.');
  return [i, f];
}

function cmpValues(type: FieldType, a: EvalValue, b: Literal): number {
  switch (type) {
    case 'int': {
      const x = typeof a === 'bigint' ? a : BigInt(a as number);
      const y = BigInt(b as number);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 'money':
      return compareDecimal(String(a), String(b));
    case 'date':
    case 'string':
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    case 'bool':
      return a === b ? 0 : a ? 1 : -1;
    case 'stringSet':
      throw new ConditionError('stringSet fields support only `contains`');
  }
}

export function evaluate(c: Condition, ctx: EvalContext): boolean {
  switch (c.op) {
    case 'true':
      return true;
    case 'and':
      return c.terms.every((t) => evaluate(t, ctx));
    case 'or':
      return c.terms.some((t) => evaluate(t, ctx));
    case 'not':
      return !evaluate(c.term, ctx);
    case 'contains': {
      const v = ctx[c.field];
      return Array.isArray(v) && v.includes(c.value);
    }
    case 'in': {
      const def = FIELDS[c.field];
      const v = ctx[c.field];
      if (!def || v === undefined) return false;
      return c.values.some((x) => cmpValues(def.type, v, x) === 0);
    }
    default: {
      const def = FIELDS[c.field];
      const v = ctx[c.field];
      if (!def || v === undefined) return false;
      const r = cmpValues(def.type, v, c.value);
      switch (c.op) {
        case 'eq':
          return r === 0;
        case 'neq':
          return r !== 0;
        case 'gt':
          return r > 0;
        case 'gte':
          return r >= 0;
        case 'lt':
          return r < 0;
        case 'lte':
          return r <= 0;
      }
    }
  }
}

function literalMatches(type: FieldType, v: Literal): boolean {
  switch (type) {
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'money':
      return typeof v === 'string' && DEC_RE.test(v);
    case 'date':
      return typeof v === 'string' && DATE_RE.test(v);
    case 'string':
      return typeof v === 'string';
    case 'bool':
      return typeof v === 'boolean';
    case 'stringSet':
      return typeof v === 'string';
  }
}

/**
 * Static validation: every field exists, is allowed in the given scopes,
 * and every literal type-checks against its field.
 */
export function validateCondition(c: unknown, scopes: readonly Scope[], path = 'condition'): string[] {
  const errs: string[] = [];
  if (!c || typeof c !== 'object') return [`${path}: not an object`];
  const n = c as Record<string, unknown>;
  const field = (f: unknown): FieldDef | undefined => {
    if (typeof f !== 'string') {
      errs.push(`${path}: field must be a string`);
      return undefined;
    }
    const def = FIELDS[f];
    if (!def) {
      errs.push(`${path}: unknown field "${f}"`);
      return undefined;
    }
    if (!scopes.includes(def.scope)) {
      errs.push(`${path}: field "${f}" is not available here (allowed scopes: ${scopes.join(', ')})`);
      return undefined;
    }
    return def;
  };
  switch (n.op) {
    case 'true':
      break;
    case 'and':
    case 'or':
      if (!Array.isArray(n.terms) || n.terms.length === 0) errs.push(`${path}: ${n.op} needs a non-empty terms array`);
      else n.terms.forEach((t, i) => errs.push(...validateCondition(t, scopes, `${path}.terms[${i}]`)));
      break;
    case 'not':
      errs.push(...validateCondition(n.term, scopes, `${path}.term`));
      break;
    case 'contains': {
      const d = field(n.field);
      if (d && d.type !== 'stringSet') errs.push(`${path}: contains requires a stringSet field, "${String(n.field)}" is ${d.type}`);
      if (typeof n.value !== 'string') errs.push(`${path}: contains value must be a string`);
      break;
    }
    case 'in': {
      const d = field(n.field);
      if (!Array.isArray(n.values) || n.values.length === 0) errs.push(`${path}: in needs a non-empty values array`);
      else if (d) {
        if (d.type === 'stringSet') errs.push(`${path}: use contains for stringSet fields`);
        n.values.forEach((v, i) => {
          if (!literalMatches(d.type, v as Literal)) errs.push(`${path}.values[${i}]: ${JSON.stringify(v)} is not a valid ${d.type}`);
        });
      }
      break;
    }
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const d = field(n.field);
      if (d) {
        if (d.type === 'stringSet') errs.push(`${path}: use contains for stringSet fields`);
        else if (!literalMatches(d.type, n.value as Literal))
          errs.push(`${path}: ${JSON.stringify(n.value)} is not a valid ${d.type} for "${String(n.field)}"`);
        if (d.type === 'bool' && n.op !== 'eq' && n.op !== 'neq') errs.push(`${path}: bool fields support only eq/neq`);
      }
      break;
    }
    default:
      errs.push(`${path}: unknown operator ${JSON.stringify(n.op)}`);
  }
  return errs;
}

/** Fields referenced by a condition — lets you ask "which rules could touch X?" without executing. */
export function referencedFields(c: Condition): string[] {
  const out = new Set<string>();
  const walk = (x: Condition): void => {
    switch (x.op) {
      case 'true':
        return;
      case 'and':
      case 'or':
        x.terms.forEach(walk);
        return;
      case 'not':
        walk(x.term);
        return;
      default:
        out.add(x.field);
    }
  };
  walk(c);
  return [...out].sort();
}

/** Human-readable rendering, for the admin UI and trace. */
export function describeCondition(c: Condition): string {
  switch (c.op) {
    case 'true':
      return 'always';
    case 'and':
      return c.terms.map(describeCondition).join(' AND ');
    case 'or':
      return '(' + c.terms.map(describeCondition).join(' OR ') + ')';
    case 'not':
      return `NOT (${describeCondition(c.term)})`;
    case 'contains':
      return `${c.field} contains ${JSON.stringify(c.value)}`;
    case 'in':
      return `${c.field} in [${c.values.map((v) => JSON.stringify(v)).join(', ')}]`;
    default: {
      const sym = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[c.op];
      return `${c.field} ${sym} ${JSON.stringify(c.value)}`;
    }
  }
}
