/**
 * Structural diff between two rule-set definitions, so a reviewer sees
 * exactly what changed (design guide §12.2). Arrays of objects with an `id`
 * are matched by id, not position.
 */
export type DiffEntry = { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keyed = (a: unknown[]): boolean => a.length > 0 && a.every((x) => isObj(x) && typeof x.id === 'string');

export function diff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && (keyed(before) || keyed(after)) && (before.length === 0 || keyed(before)) && (after.length === 0 || keyed(after))) {
    const out: DiffEntry[] = [];
    const b = new Map(before.map((x) => [(x as { id: string }).id, x]));
    const a = new Map(after.map((x) => [(x as { id: string }).id, x]));
    for (const id of [...new Set([...b.keys(), ...a.keys()])].sort()) {
      const p = `${path}[${id}]`;
      if (!a.has(id)) out.push({ path: p, kind: 'removed', before: b.get(id) });
      else if (!b.has(id)) out.push({ path: p, kind: 'added', after: a.get(id) });
      else out.push(...diff(b.get(id), a.get(id), p));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in after)) out.push({ path: p, kind: 'removed', before: before[k] });
      else if (!(k in before)) out.push({ path: p, kind: 'added', after: after[k] });
      else out.push(...diff(before[k], after[k], p));
    }
    return out;
  }
  return [{ path: path || '(root)', kind: 'changed', before, after }];
}
