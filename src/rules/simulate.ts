/**
 * Mandatory simulation before a rule change can be approved (design guide
 * §12.2): re-price recent quotes under the proposed rule set and measure the
 * revenue delta and the change in approval load.
 */
import { add, format, neg, sub, type Money } from '../money/money.ts';
import { priceQuote } from '../pricing/pipeline.ts';
import { deserialize } from '../pricing/codec.ts';
import type { PriceBook, PricedQuote, RuleSet } from '../pricing/types.ts';
import { resolvePlan, type Directory } from '../approvals/approvals.ts';
import type { QuoteRecord, QuoteVersionRecord } from '../store/store.ts';

export type SimulationRow = {
  quoteId: string;
  quoteNumber: number;
  version: number;
  before: string;
  after: string;
  delta: string;
  deltaMinor: string;
  approvalStagesBefore: number;
  approvalStagesAfter: number;
  newlyRequiresApproval: boolean;
  error?: string;
};

export type SimulationReport = {
  proposedHash: string;
  sampleSize: number;
  simulatedAt: string;
  currency: string;
  totalBefore: string;
  totalAfter: string;
  totalDelta: string;
  totalDeltaMinor: string;
  increased: number;
  decreased: number;
  unchanged: number;
  errors: number;
  newlyRequiresApproval: number;
  noLongerRequiresApproval: number;
  rows: SimulationRow[];
  headline: string;
};

export function simulate(args: {
  proposed: RuleSet;
  proposedHash: string;
  sample: Array<{ quote: QuoteRecord; version: QuoteVersionRecord; ruleSet: RuleSet }>;
  priceBook: (v: number) => PriceBook;
  directory: Directory;
  at: string;
}): SimulationReport {
  const rows: SimulationRow[] = [];
  let before: Money | null = null;
  let after: Money | null = null;
  const addM = (a: Money | null, b: Money): Money => (a ? add(a, b) : b);

  for (const { quote, version, ruleSet } of args.sample) {
    const current = deserialize<PricedQuote>(version.materialized);
    const pb = args.priceBook(version.priceBookVersion);
    const plansBefore = safeStages(() => resolvePlan(current, version.config, ruleSet, quote.ownerId, args.directory));
    try {
      const repriced = priceQuote(version.config, args.proposed, pb);
      const stagesAfter = safeStages(() => resolvePlan(repriced, version.config, args.proposed, quote.ownerId, args.directory));
      const d = sub(repriced.total, current.total);
      before = addM(before, current.total);
      after = addM(after, repriced.total);
      rows.push({
        quoteId: quote.id,
        quoteNumber: quote.number,
        version: version.version,
        before: format(current.total),
        after: format(repriced.total),
        delta: format(d),
        deltaMinor: d.minor.toString(),
        approvalStagesBefore: plansBefore,
        approvalStagesAfter: stagesAfter,
        newlyRequiresApproval: stagesAfter > plansBefore,
      });
    } catch (e) {
      rows.push({
        quoteId: quote.id,
        quoteNumber: quote.number,
        version: version.version,
        before: format(current.total),
        after: '—',
        delta: '—',
        deltaMinor: '0',
        approvalStagesBefore: plansBefore,
        approvalStagesAfter: plansBefore,
        newlyRequiresApproval: false,
        error: (e as Error).message,
      });
    }
  }
  const tb = before;
  const ta = after;
  const delta = tb && ta ? sub(ta, tb) : null;
  const ok = rows.filter((r) => !r.error);
  const report: SimulationReport = {
    proposedHash: args.proposedHash,
    sampleSize: rows.length,
    simulatedAt: args.at,
    currency: args.proposed.currency,
    totalBefore: tb ? format(tb) : '—',
    totalAfter: ta ? format(ta) : '—',
    totalDelta: delta ? format(delta) : '—',
    totalDeltaMinor: delta ? delta.minor.toString() : '0',
    increased: ok.filter((r) => BigInt(r.deltaMinor) > 0n).length,
    decreased: ok.filter((r) => BigInt(r.deltaMinor) < 0n).length,
    unchanged: ok.filter((r) => BigInt(r.deltaMinor) === 0n).length,
    errors: rows.length - ok.length,
    newlyRequiresApproval: ok.filter((r) => r.newlyRequiresApproval).length,
    noLongerRequiresApproval: ok.filter((r) => r.approvalStagesAfter < r.approvalStagesBefore).length,
    rows,
    headline: '',
  };
  report.headline =
    rows.length === 0
      ? 'No historical quotes to simulate against yet.'
      : `This change would have ${delta && delta.minor < 0n ? 'reduced' : delta && delta.minor > 0n ? 'increased' : 'not changed'} revenue on the last ${rows.length} quote(s)` +
        (delta && delta.minor !== 0n ? ` by ${format(delta.minor < 0n ? neg(delta) : delta)}` : '') +
        `; ${report.newlyRequiresApproval} would newly need more approval, ${report.noLongerRequiresApproval} would need less` +
        (report.errors ? `; ${report.errors} would fail to price` : '') +
        '.';
  return report;
}

function safeStages(f: () => { stages: unknown[] }): number {
  try {
    return f().stages.length;
  } catch {
    return 0;
  }
}
