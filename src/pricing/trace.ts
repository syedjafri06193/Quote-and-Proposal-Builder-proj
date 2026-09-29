/**
 * Render a price trace as a readable waterfall (design guide §6.4).
 */
import { format } from '../money/money.ts';
import type { PricedQuote } from './types.ts';

export function renderTrace(q: PricedQuote): string {
  const out: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
  for (const line of q.lines) {
    out.push(`Line ${line.lineId}: ${line.name} × ${line.quantity}${line.chargeType === 'recurring' ? ` (${line.termMonths} mo)` : ''}`);
    for (const t of q.trace.filter((x) => x.lineId === line.lineId)) {
      const label = t.ruleName ?? t.stage;
      const delta = t.delta ? format(t.delta) : '';
      const after = t.after ? format(t.after) : '';
      out.push(`  ${pad(label, 28)} ${lpad(delta, 16)} ${lpad(after, 16)}`);
      out.push(`    ${t.ruleId ? `rule: ${t.ruleId} · ` : ''}${t.explanation}`);
    }
    out.push(`  ${pad('Net', 28)} ${lpad('', 16)} ${lpad(format(line.net), 16)}`);
    out.push('');
  }
  for (const t of q.trace.filter((x) => !x.lineId && x.stage !== 'configure')) {
    out.push(`${pad(t.ruleName ?? t.stage, 30)} ${t.explanation}`);
  }
  out.push(`TOTAL ${format(q.total)}  (list ${format(q.listTotal)}, discount ${(q.totalDiscountBasisPoints / 100).toFixed(2)}%)`);
  return out.join('\n');
}
