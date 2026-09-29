/**
 * HTTP API + static UI. Dependency-free (node:http).
 *
 * Authentication is out of scope for this reference build: the acting user
 * is taken from the `X-User` header (the UI has a user switcher). Put real
 * auth (OIDC/SAML) in front before using this with real data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../app/app.ts';
import { DomainError } from '../app/errors.ts';
import { InvalidTransitionError } from '../approvals/stateMachine.ts';
import { WebhookVerificationError } from '../esign/provider.ts';
import { FakeESignProvider } from '../esign/fake.ts';
import { toApi } from '../pricing/codec.ts';
import { FIELDS } from '../pricing/conditions.ts';
import { ROUNDING_MODES } from '../money/money.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: string; user: string };
type Handler = (c: Ctx) => Promise<unknown> | unknown;

class RawResponse {
  constructor(
    readonly contentType: string,
    readonly body: string | Uint8Array,
    readonly headers: Record<string, string> = {},
  ) {}
}

export function buildRouter(app: App) {
  const { quotes, store } = app;
  const routes: Array<{ method: string; re: RegExp; keys: string[]; h: Handler }> = [];
  const route = (method: string, path: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, h });
  };
  const json = (c: Ctx): Record<string, unknown> => {
    if (!c.body) return {};
    try {
      return JSON.parse(c.body) as Record<string, unknown>;
    } catch {
      throw new DomainError(400, 'bad_json', 'request body is not valid JSON');
    }
  };
  const ver = (c: Ctx) => (c.url.searchParams.get('version') ? Number(c.url.searchParams.get('version')) : undefined);
  const fake = () => {
    if (!(app.provider instanceof FakeESignProvider)) throw new DomainError(404, 'not_found', 'fake provider controls are only available with the fake provider');
    return app.provider;
  };

  // ── directory & catalog ──
  route('GET', '/api/users', () => store.users());
  route('GET', '/api/accounts', () => store.accounts());
  route('GET', '/api/catalog', () => {
    const rs = quotes.rules.current();
    return { priceBook: store.latestPriceBook(), ruleSetVersion: rs.version, tiers: rs.tiers, promoRules: rs.discountRules.map((r) => ({ id: r.id, name: r.name })) };
  });
  route('GET', '/api/meta', () => ({ fields: FIELDS, roundingModes: ROUNDING_MODES, now: app.clock.now() }));

  // ── quotes ──
  route('GET', '/api/quotes', () => quotes.listQuotes());
  route('POST', '/api/quotes', (c) => quotes.createQuote(c.user, json(c) as never));
  route('GET', '/api/quotes/:id', (c) => ({ ...quotes.getQuote(c.params.id!, ver(c)), approvals: quotes.progress(c.params.id!), envelopes: store.envelopes(c.params.id!), documents: store.documents(c.params.id!), hasContract: !!store.contract(c.params.id!) }));
  route('PATCH', '/api/quotes/:id', (c) => quotes.editQuote(c.user, c.params.id!, json(c) as never));
  route('POST', '/api/quotes/:id/reprice', (c) => quotes.reprice(c.user, c.params.id!));
  route('POST', '/api/quotes/:id/clone', (c) => quotes.cloneQuote(c.user, c.params.id!));
  route('POST', '/api/quotes/:id/submit', (c) => quotes.submit(c.user, c.params.id!, String(json(c).note ?? '')));
  route('GET', '/api/quotes/:id/approvals', (c) => quotes.progress(c.params.id!));
  route('POST', '/api/quotes/:id/approvals/:slot', (c) => {
    const b = json(c);
    const opts: { conditions?: string; comment?: string } = {};
    if (typeof b.conditions === 'string') opts.conditions = b.conditions;
    if (typeof b.comment === 'string') opts.comment = b.comment;
    return quotes.decide(c.user, c.params.id!, c.params.slot!, b.decision as 'approved' | 'rejected' | 'conditional', opts);
  });
  route('POST', '/api/quotes/:id/recall', async (c) => {
    await quotes.recall(c.user, c.params.id!, String(json(c).reason ?? 'recalled by rep'));
    return quotes.getQuote(c.params.id!).quote;
  });
  route('GET', '/api/quotes/:id/document.pdf', async (c) => {
    const { bytes, record } = await quotes.generateDocument(c.params.id!, ver(c));
    return new RawResponse('application/pdf', bytes, { 'X-Document-SHA256': record.sha256, 'Content-Disposition': `inline; filename="${c.params.id}-v${record.quoteVersion}.pdf"` });
  });
  route('GET', '/api/quotes/:id/signed.pdf', (c) => {
    const k = store.contract(c.params.id!);
    const b = k && store.blob(k.signedDocKey);
    if (!b) throw new DomainError(404, 'not_found', 'no executed document');
    return new RawResponse('application/pdf', b);
  });
  route('POST', '/api/quotes/:id/send', (c) => quotes.send(c.user, c.params.id!));
  route('GET', '/api/quotes/:id/trace.txt', (c) => new RawResponse('text/plain; charset=utf-8', quotes.traceText(c.params.id!, ver(c))));
  route('GET', '/api/quotes/:id/events', (c) => store.events(c.params.id!));
  route('GET', '/api/quotes/:id/audit', (c) => quotes.auditExport(c.params.id!));
  route('GET', '/api/quotes/:id/contract', (c) => quotes.contract(c.params.id!));
  route('GET', '/api/inbox', (c) => quotes.inbox(c.user));
  route('POST', '/api/delegations', (c) => {
    const b = json(c);
    quotes.delegate(c.user, String(b.toUserId), String(b.until), String(b.reason ?? ''));
    return { ok: true };
  });
  route('GET', '/api/delegations', () => store.delegations());
  route('POST', '/api/escalations/run', () => quotes.runEscalations());

  // ── e-signature ──
  route('POST', '/api/esign/webhook', async (c) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(c.req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    return quotes.handleWebhook(headers, c.body);
  });
  route('POST', '/api/esign/reconcile', (c) => quotes.reconcile(Number(c.url.searchParams.get('olderThanMinutes') ?? '0')));
  route('GET', '/api/esign/fake/envelopes', () => ({ envelopes: fake().list(), dropWebhooks: fake().dropWebhooks, dropped: fake().dropped.length }));
  route('POST', '/api/esign/fake/drop', (c) => {
    fake().dropWebhooks = Boolean(json(c).drop);
    return { dropWebhooks: fake().dropWebhooks };
  });
  route('POST', '/api/esign/fake/redeliver', async () => {
    await fake().redeliverDropped();
    return { ok: true };
  });
  route('POST', '/api/esign/fake/:pid/:action', async (c) => {
    const f = fake();
    const pid = c.params.pid!;
    switch (c.params.action) {
      case 'view':
        await f.view(pid);
        break;
      case 'sign':
        await f.sign(pid);
        break;
      case 'decline':
        await f.decline(pid, String(json(c).reason ?? 'Declined by signer'));
        break;
      case 'expire':
        await f.expire(pid);
        break;
      case 'tamper':
        f.tamper(pid);
        break;
      default:
        throw new DomainError(404, 'not_found', 'unknown action');
    }
    return { ok: true, envelopes: f.list() };
  });

  // ── rules governance ──
  route('GET', '/api/rules', () => quotes.rules.list());
  route('GET', '/api/rules/diff', (c) => quotes.rules.diffVersions(Number(c.url.searchParams.get('a')), Number(c.url.searchParams.get('b'))));
  route('GET', '/api/rules/drafts', () => quotes.rules.listDrafts());
  route('POST', '/api/rules/drafts', (c) => {
    const b = json(c);
    const input: Parameters<typeof quotes.rules.createDraft>[1] = { title: String(b.title ?? '') };
    if (typeof b.basedOnVersion === 'number') input.basedOnVersion = b.basedOnVersion;
    if (typeof b.effectiveFrom === 'string') input.effectiveFrom = b.effectiveFrom;
    return quotes.rules.createDraft(c.user, input);
  });
  route('GET', '/api/rules/drafts/:id', (c) => quotes.rules.getDraft(c.params.id!));
  route('PATCH', '/api/rules/drafts/:id', (c) => quotes.rules.updateDraft(c.user, c.params.id!, json(c) as never));
  route('POST', '/api/rules/drafts/:id/simulate', (c) => quotes.rules.simulateDraft(c.user, c.params.id!, Number(json(c).sampleSize ?? 200)));
  route('POST', '/api/rules/drafts/:id/submit', (c) => quotes.rules.submitDraft(c.user, c.params.id!, String(json(c).note ?? '')));
  route('POST', '/api/rules/drafts/:id/approve', (c) => quotes.rules.approveDraft(c.user, c.params.id!, String(json(c).note ?? '')));
  route('POST', '/api/rules/drafts/:id/reject', (c) => quotes.rules.rejectDraft(c.user, c.params.id!, String(json(c).note ?? '')));
  route('GET', '/api/rules/:version', (c) => quotes.rules.byVersion(Number(c.params.version)));

  // ── governance & audit ──
  route('GET', '/api/reports/non-standard', () => quotes.nonStandardReport());
  route('GET', '/api/admin/replay', () => {
    const r = quotes.replayAll();
    return { total: r.length, failures: r.filter((x) => !x.ok) };
  });
  route('GET', '/api/admin/consistency', () => ({ mismatches: quotes.consistencyCheck() }));
  route('GET', '/api/admin/flags', () => store.flags());
  route('GET', '/api/outbox', () => store.outbox());

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const method = req.method ?? 'GET';
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
        const user = String(req.headers['x-user'] ?? '');
        if (!user && !url.pathname.startsWith('/api/esign/webhook') && method !== 'GET') throw new DomainError(401, 'unauthenticated', 'X-User header required');
        const out = await r.h({ req, res, url, params, body, user });
        if (out instanceof RawResponse) {
          res.writeHead(200, { 'Content-Type': out.contentType, ...out.headers });
          res.end(out.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toApi(out ?? null)));
        return;
      }
      throw new DomainError(404, 'not_found', `no route ${method} ${url.pathname}`);
    } catch (e) {
      const [status, code, message, details] =
        e instanceof DomainError
          ? [e.status, e.code, e.message, e.details]
          : e instanceof InvalidTransitionError
            ? [409, 'invalid_transition', e.message, undefined]
            : e instanceof WebhookVerificationError
              ? [401, 'bad_webhook', e.message, undefined]
              : [500, 'internal', (e as Error).message, undefined];
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code, message, details: toApi(details) } }));
    }
  };
}

function serveStatic(path: string, res: ServerResponse): void {
  const file = path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : path.replace(/^\/+/, '');
  const full = join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
}

// ── entry point ──
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp({ dataFile: process.env.DATA_FILE ?? 'data/db.json', log: (m, d) => console.log(`[${new Date().toISOString()}] ${m}`, d ?? '') });
  const server = createServer(buildRouter(app));
  server.listen(port, () => console.log(`Quote & Proposal Builder on http://localhost:${port}  (admin: /admin)`));
  // Safety nets: e-sign reconciliation every 15 minutes, approval escalation hourly.
  setInterval(() => void app.quotes.reconcile(10).catch((e) => console.error('reconcile failed', e)), 15 * 60_000).unref();
  setInterval(() => {
    try {
      app.quotes.runEscalations();
    } catch (e) {
      console.error('escalation failed', e);
    }
  }, 60 * 60_000).unref();
}
