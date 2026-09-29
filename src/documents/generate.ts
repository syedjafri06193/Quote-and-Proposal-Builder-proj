/**
 * Deterministic proposal generation (design guide §9).
 *
 * Built directly on pdf-lib with the standard Helvetica fonts (not embedded,
 * so no font-subset variance), fixed metadata dates taken from the quote's
 * priced-at time, and no "generated on" clock reads. Generating the same
 * quote twice produces byte-identical PDFs — asserted in tests.
 *
 * The render model's hash (`contentHash`) is embedded in the PDF keywords and
 * the footer. After signature the provider's overlay changes the bytes, so the
 * integrity check reads this reference back instead (design guide §10.4).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { format, bpToPercentString, rescale, totalScale, type Money } from '../money/money.ts';
import type { PricedQuote, QuoteConfig } from '../pricing/types.ts';
import type { Account } from '../seed/data.ts';
import type { TemplateBody } from '../store/store.ts';
import { hashJson, sha256 } from '../util/hash.ts';

export const TEMPLATE_ENGINE_VERSION = 'pdf-1.0.0';
export const CONTENT_REF_PREFIX = 'qpb-content:';
/** Anchor strings the e-signature provider uses to place fields (anchor text, never coordinates). */
export const ANCHORS = { signature: '/sig1/', name: '/name1/', date: '/date1/' } as const;

export type RenderModel = {
  templateVersion: number;
  engine: string;
  quoteNumber: number;
  quoteVersion: number;
  pricedAt: string;
  title: string;
  intro: string;
  preparedFor: string;
  company: { name: string; address: string };
  customer: { name: string; address: string; signerName: string; signerTitle: string };
  rows: Array<{ name: string; sku: string; description: string; qty: string; term: string; unit: string; discount: string; amount: string }>;
  totals: { list: string; discount: string; orderDiscount: string; hasOrderDiscount: boolean; total: string };
  terms: { start: string; months: number; payment: string; autoRenew: string; legal: string };
  showSla: boolean;
  sla: string[];
  termsSummary: string[];
  footerNote: string;
  nonStandard: boolean;
  approvalConditions: string[];
};

export function buildRenderModel(args: {
  priced: PricedQuote;
  config: QuoteConfig;
  account: Account;
  template: { version: number; body: TemplateBody };
  quoteNumber: number;
  quoteVersion: number;
  pricedAt: string;
  approvalConditions: string[];
}): RenderModel {
  const { priced: q, config: c, account: a, template: t } = args;
  const addr = a.billingAddress;
  return {
    templateVersion: t.version,
    engine: TEMPLATE_ENGINE_VERSION,
    quoteNumber: args.quoteNumber,
    quoteVersion: args.quoteVersion,
    pricedAt: args.pricedAt,
    title: c.cover.title || 'Proposal',
    intro: c.cover.intro,
    preparedFor: c.cover.preparedFor || a.signer.name,
    company: { name: t.body.companyName, address: t.body.companyAddress },
    customer: {
      name: a.name,
      address: `${addr.line1}, ${addr.city}, ${addr.region} ${addr.postalCode}, ${addr.country}`,
      signerName: a.signer.name,
      signerTitle: a.signer.title,
    },
    rows: q.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      description: l.description,
      qty: l.quantity.toString(),
      term: l.chargeType === 'recurring' ? `${l.termMonths} mo` : 'one-time',
      unit: displayUnit(l.unitPrice) + (l.chargeType === 'recurring' ? '/yr' : ''),
      discount: l.totalDiscountBasisPoints > 0 ? bpToPercentString(l.totalDiscountBasisPoints) : '—',
      amount: format(l.net),
    })),
    totals: {
      list: format(q.listTotal),
      discount: bpToPercentString(q.totalDiscountBasisPoints),
      orderDiscount: format(q.orderDiscount),
      hasOrderDiscount: q.orderDiscount.minor !== 0n,
      total: format(q.total),
    },
    terms: {
      start: q.startDate,
      months: q.termMonths,
      payment: `Net ${q.paymentTerms.netDays}, ${q.paymentTerms.method}`,
      autoRenew: c.autoRenew ? `Auto-renews; ${c.noticePeriodDays} days' notice to cancel` : 'Does not auto-renew',
      legal: q.legalTermsVersion,
    },
    // Conditional section: SLA appendix for enterprise customers or premium support.
    showSla: c.segment === 'enterprise' || q.lines.some((l) => l.productId === 'prem'),
    sla: t.body.slaAppendix,
    termsSummary: t.body.termsSummary,
    footerNote: t.body.footerNote,
    nonStandard: q.quoteType === 'non-standard',
    approvalConditions: args.approvalConditions,
  };
}

export function contentHashOf(m: RenderModel): string {
  return hashJson(m);
}

/**
 * Effective unit prices carry 6 dp internally. For display: cents when the
 * price is at least one currency unit, otherwise up to 6 dp (e.g. $0.000837).
 * Display only — the contract data keeps the exact value.
 */
export function displayUnit(u: Money): string {
  const unit = 10n ** BigInt(u.scale);
  const abs = u.minor < 0n ? -u.minor : u.minor;
  return abs >= unit ? format(rescale(u, totalScale(u.currency), 'half-up')) : format(u);
}

export type GeneratedDoc = { bytes: Uint8Array; sha256: string; contentHash: string; templateVersion: number; pageCount: number };

// WinAnsi-safe text for the standard fonts.
const REPL: Record<string, string> = { '−': '-', '≥': '>=', '≤': '<=', '→': '->', '✓': 'v', '≠': '!=', ' ': ' ' };
const EXTRA_OK = new Set(['—', '–', '·', '•', '€', '’', '‘', '“', '”', '…', '×']);
export function pdfSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    if (REPL[ch] !== undefined) out += REPL[ch];
    else if ((ch.codePointAt(0) ?? 0) <= 0xff || EXTRA_OK.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of pdfSafe(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) cur = tryLine;
      else {
        if (cur) lines.push(cur);
        // hard-break very long words
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let k = w.length;
          while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > width) k--;
          lines.push(w.slice(0, k));
          w = w.slice(k);
        }
        cur = w;
      }
    }
    lines.push(cur);
  }
  return lines;
}

const PAGE = { w: 612, h: 792, m: 54 };
const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.82, 0.84, 0.88);
const ACCENT = rgb(0.13, 0.33, 0.62);

export async function generateProposalPdf(model: RenderModel): Promise<GeneratedDoc> {
  const contentHash = contentHashOf(model);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const when = new Date(model.pricedAt);
  doc.setTitle(pdfSafe(`${model.title} — Q-${model.quoteNumber} v${model.quoteVersion}`));
  doc.setAuthor(pdfSafe(model.company.name));
  doc.setSubject(pdfSafe(`Proposal for ${model.customer.name}`));
  doc.setKeywords([`${CONTENT_REF_PREFIX}${contentHash}`, `template:${model.templateVersion}`]);
  doc.setProducer(`quote-builder/${TEMPLATE_ENGINE_VERSION}`);
  doc.setCreator('quote-builder');
  doc.setCreationDate(when);
  doc.setModificationDate(when);

  let page!: PDFPage;
  let y = 0;
  const contentW = PAGE.w - PAGE.m * 2;
  const bottom = PAGE.m + 36; // leave room for footer
  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.m;
  };
  const text = (s: string, x: number, size = 10, font = regular, color = INK) => {
    page.drawText(pdfSafe(s), { x, y, size, font, color });
  };
  const ensure = (h: number) => {
    if (y - h < bottom) newPage();
  };
  const para = (s: string, size = 10, font = regular, color = INK, gap = 4) => {
    for (const ln of wrap(s, font, size, contentW)) {
      ensure(size + gap);
      y -= size;
      text(ln, PAGE.m, size, font, color);
      y -= gap;
    }
  };

  // ── header ──
  newPage();
  y -= 10;
  text(model.company.name, PAGE.m, 11, bold, ACCENT);
  const ref = `Quote Q-${model.quoteNumber} · v${model.quoteVersion}`;
  page.drawText(pdfSafe(ref), { x: PAGE.w - PAGE.m - regular.widthOfTextAtSize(pdfSafe(ref), 9), y, size: 9, font: regular, color: MUTED });
  y -= 14;
  text(model.company.address, PAGE.m, 8, regular, MUTED);
  y -= 38;
  para(model.title, 22, bold);
  y -= 2;
  para(`Prepared for ${model.preparedFor}, ${model.customer.name}`, 11, regular, MUTED);
  para(`Pricing as of ${model.pricedAt.slice(0, 10)}`, 9, regular, MUTED);
  if (model.nonStandard) para('Non-standard commercial terms — approved by finance.', 9, bold, rgb(0.6, 0.3, 0.05));
  y -= 10;
  if (model.intro) para(model.intro, 10.5, regular, INK, 5);
  y -= 14;

  // ── line items (repeating header, rows never split across pages) ──
  const cols = [
    { k: 'item', label: 'Item', x: PAGE.m, w: 214, align: 'left' as const },
    { k: 'qty', label: 'Qty', x: PAGE.m + 214, w: 56, align: 'right' as const },
    { k: 'term', label: 'Term', x: PAGE.m + 270, w: 56, align: 'right' as const },
    { k: 'unit', label: 'Unit price', x: PAGE.m + 326, w: 76, align: 'right' as const },
    { k: 'disc', label: 'Disc.', x: PAGE.m + 402, w: 40, align: 'right' as const },
    { k: 'amt', label: 'Amount', x: PAGE.m + 442, w: 62, align: 'right' as const },
  ];
  const cell = (s: string, col: (typeof cols)[number], size: number, font: PDFFont, color = INK) => {
    const t = pdfSafe(s);
    const x = col.align === 'right' ? col.x + col.w - font.widthOfTextAtSize(t, size) : col.x;
    page.drawText(t, { x, y, size, font, color });
  };
  const tableHeader = () => {
    y -= 12;
    for (const c of cols) cell(c.label, c, 8.5, bold, MUTED);
    y -= 6;
    page.drawLine({ start: { x: PAGE.m, y }, end: { x: PAGE.w - PAGE.m, y }, thickness: 0.8, color: RULE });
  };
  ensure(60);
  tableHeader();
  for (const r of model.rows) {
    const nameLines = wrap(r.name, bold, 9.5, cols[0]!.w - 8);
    const descLines = r.description ? wrap(r.description, regular, 8, cols[0]!.w - 8) : [];
    const rowH = nameLines.length * 12 + 11 + descLines.length * 10 + 10;
    if (y - rowH < bottom) {
      newPage();
      tableHeader();
    }
    y -= 14;
    const top = y;
    cell(r.qty, cols[1]!, 9.5, regular);
    cell(r.term, cols[2]!, 9.5, regular);
    cell(r.unit, cols[3]!, 9.5, regular);
    cell(r.discount, cols[4]!, 9.5, regular);
    cell(r.amount, cols[5]!, 9.5, bold);
    for (const [i, ln] of nameLines.entries()) {
      if (i) y -= 12;
      cell(ln, cols[0]!, 9.5, bold);
    }
    y -= 11;
    cell(r.sku, cols[0]!, 7.5, regular, MUTED);
    for (const ln of descLines) {
      y -= 10;
      cell(ln, cols[0]!, 8, regular, MUTED);
    }
    y = Math.min(y, top) - 8;
    page.drawLine({ start: { x: PAGE.m, y }, end: { x: PAGE.w - PAGE.m, y }, thickness: 0.4, color: RULE });
  }

  // ── totals ──
  ensure(90);
  y -= 8;
  const tot = (label: string, value: string, strong = false) => {
    y -= strong ? 16 : 13;
    const f = strong ? bold : regular;
    const sz = strong ? 12 : 9.5;
    page.drawText(pdfSafe(label), { x: PAGE.m + 300, y, size: sz, font: f, color: strong ? INK : MUTED });
    const v = pdfSafe(value);
    page.drawText(v, { x: PAGE.w - PAGE.m - f.widthOfTextAtSize(v, sz), y, size: sz, font: f, color: INK });
  };
  tot('List price', model.totals.list);
  tot('Total discount', model.totals.discount);
  if (model.totals.hasOrderDiscount) tot('Includes order discount', model.totals.orderDiscount);
  tot('Total', model.totals.total, true);
  y -= 12;
  para('Taxes, if applicable, are calculated at invoicing and are not included above.', 8, regular, MUTED);
  y -= 10;

  // ── commercial terms ──
  ensure(90);
  para('Commercial terms', 12, bold);
  y -= 2;
  for (const [k, v] of [
    ['Start date', model.terms.start],
    ['Term', `${model.terms.months} months`],
    ['Payment', model.terms.payment],
    ['Renewal', model.terms.autoRenew],
    ['Legal terms', model.terms.legal],
  ] as const) {
    ensure(14);
    y -= 12;
    text(k, PAGE.m, 9.5, bold, MUTED);
    text(v, PAGE.m + 110, 9.5);
  }
  for (const c of model.approvalConditions) para(`Condition: ${c}`, 9, regular);
  y -= 12;
  for (const t of model.termsSummary) para(`•  ${t}`, 9, regular, INK, 3);

  // ── conditional SLA appendix ──
  if (model.showSla && model.sla.length) {
    y -= 12;
    ensure(80);
    para('Appendix A — Service level agreement', 12, bold);
    for (const t of model.sla) para(`•  ${t}`, 9, regular, INK, 3);
  }

  // ── signature block: fixed-height, never split, anchors in a fixed position within it ──
  const SIG_H = 150;
  y -= 18;
  if (y - SIG_H < bottom) newPage();
  para('Acceptance', 12, bold);
  para(`Signed for and on behalf of ${model.customer.name}.`, 9, regular, MUTED);
  y -= 30;
  const line = (label: string, anchor: string) => {
    page.drawLine({ start: { x: PAGE.m, y }, end: { x: PAGE.m + 260, y }, thickness: 0.8, color: INK });
    // Anchor text in white 1pt: invisible to readers, found by the e-sign provider.
    page.drawText(anchor, { x: PAGE.m + 2, y: y + 3, size: 1, font: regular, color: rgb(1, 1, 1) });
    y -= 11;
    text(label, PAGE.m, 8, regular, MUTED);
    y -= 26;
  };
  line('Signature', ANCHORS.signature);
  line(`Name (${model.customer.signerName}, ${model.customer.signerTitle})`, ANCHORS.name);
  line('Date', ANCHORS.date);

  // ── footers, after layout so page count is known ──
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const f = pdfSafe(`Q-${model.quoteNumber} v${model.quoteVersion} · ${model.footerNote} · Ref ${contentHash.slice(0, 16)} · Page ${i + 1} of ${pages.length}`);
    p.drawText(f, { x: PAGE.m, y: PAGE.m - 8, size: 7, font: regular, color: MUTED });
  });

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, sha256: sha256(bytes), contentHash, templateVersion: model.templateVersion, pageCount: pages.length };
}

/** Read the embedded content reference back from a (possibly signed) PDF. */
export async function extractContentHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const kw = doc.getKeywords() ?? '';
    const m = new RegExp(`${CONTENT_REF_PREFIX}([0-9a-f]{64})`).exec(kw);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
