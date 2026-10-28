/** HTTP API smoke test on an ephemeral port. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../src/api/server.ts';
import { testApp } from './helpers.ts';

let server: Server;
let base = '';
const app = testApp();

beforeAll(async () => {
  server = createServer(buildRouter(app));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, user: string, payload?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-User': user }, body: payload === undefined ? null : JSON.stringify(payload) });
  const ct = res.headers.get('content-type') ?? '';
  const body = (ct.includes('json') ? await res.json() : {}) as Record<string, any>;
  return { status: res.status, body };
};

describe('API', () => {
  test('quote → approve → send → sign over HTTP', async () => {
    const created = await call('POST', '/api/quotes', 'alice', {
      accountId: 'acct-brightpath',
      lines: [{ lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: 1500 }],
    });
    expect(created.status).toBe(200);
    const id = created.body.quote.id as string;
    expect(created.body.priced.total).toMatchObject({ amount: '10200.00', currency: 'USD' });

    const sub = await call('POST', `/api/quotes/${id}/submit`, 'alice', { note: 'renewal risk' });
    const slot = sub.body.stages[0].slots[0].slotId;
    expect((await call('POST', `/api/quotes/${id}/approvals/${slot}`, 'bob', { decision: 'approved' })).status).toBe(403);
    expect((await call('POST', `/api/quotes/${id}/approvals/${slot}`, 'mike', { decision: 'approved' })).status).toBe(200);

    const pdf = await fetch(`${base}/api/quotes/${id}/document.pdf`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const sent = await call('POST', `/api/quotes/${id}/send`, 'alice');
    expect(sent.body.state).toBe('sent');
    await call('POST', `/api/esign/fake/${sent.body.providerId}/sign`, 'alice');
    const after = await call('GET', `/api/quotes/${id}`, 'alice');
    expect(after.body.quote.state).toBe('CLOSED_WON');
    expect((await call('GET', `/api/quotes/${id}/contract`, 'alice')).body.totalMinorUnits).toBe('1020000');
  });

  test('errors map to useful statuses', async () => {
    expect((await call('POST', '/api/quotes', 'alice', { accountId: 'acct-brightpath', lines: [{ lineId: 'L1', productId: 'legacy', quantity: '1' }] })).status).toBe(422);
    expect((await call('GET', '/api/quotes/nope', 'alice')).status).toBe(404);
    expect((await call('POST', '/api/quotes', '', {})).status).toBe(401);
    expect((await call('POST', '/api/esign/webhook', '', { forged: true })).status).toBe(401);
    const res = await fetch(`${base}/../package.json`);
    expect(res.status).toBe(404);
  });

  test('the edit-after-approval refusal is a 409 naming the approver', async () => {
    const c = await call('POST', '/api/quotes', 'alice', { accountId: 'acct-brightpath', lines: [{ lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: 1500 }] });
    const id = c.body.quote.id;
    const sub = await call('POST', `/api/quotes/${id}/submit`, 'alice', {});
    await call('POST', `/api/quotes/${id}/approvals/${sub.body.stages[0].slots[0].slotId}`, 'mike', { decision: 'approved' });
    await call('PATCH', `/api/quotes/${id}`, 'alice', { lines: [{ lineId: 'L1', productId: 'plat', quantity: '50', manualDiscountBp: 3500 }] });
    const r = await call('POST', `/api/quotes/${id}/send`, 'alice');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('approval_invalidated');
    expect(r.body.error.details.reapprovers).toEqual(['Mike Okafor']);
  });

  test('static files: served from public/ only', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/admin`)).status).toBe(200);
    // Encoded traversal attempts and paths outside public/ all 404.
    for (const path of ['/..%2Fpackage.json', '/%2E%2E/package.json', '/../public-x/index.html', '/nope.html']) {
      expect((await fetch(base + path)).status, path).toBe(404);
    }
  });
});
