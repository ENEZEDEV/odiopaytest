import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { Payments } from '../src/payments.js';
import { SandboxProvider } from '../src/provider.js';
import { createApi } from '../src/http.js';
import { get } from 'node:http';

async function setup(t) {
  const db = openDatabase();
  const server = createApi({ db, payments: new Payments(db, new SandboxProvider(db)), webhookSecret: randomBytes(32).toString('hex') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const call = async (path, { body, headers = {}, session } = {}) => {
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...headers
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  const login = async () => {
    const result = await call('/app-api/demo', { body: {}, headers: { 'x-odiopay-demo': '1' } });
    assert.equal(result.status, 201);
    return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrf, cookieHeader: result.headers.get('set-cookie') };
  };
  return { db, server, origin, call, login };
}

test('painel serve somente arquivos permitidos com CSP estrita', async t => {
  const f = await setup(t);
  const page = await f.call('/', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(page.status, 200);
  assert.match(page.body, /ODIOPAY/);
  assert.ok(!page.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.equal((await f.call('/src/security.js')).status, 401);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    get(f.origin, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
});

test('sessão usa cookie HttpOnly, não expõe chave e logout revoga acesso', async t => {
  const f = await setup(t); const session = await f.login();
  assert.match(session.cookieHeader, /HttpOnly/); assert.match(session.cookieHeader, /SameSite=Strict/);
  assert.equal((await f.call('/app-api/overview')).status, 401);
  const overview = await f.call('/app-api/overview', { session });
  assert.equal(overview.status, 200);
  assert.ok(!JSON.stringify(overview.body).includes('odi_sandbox_'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked=0').get().n, 0);
  assert.equal((await f.call('/app-api/logout', { session, body: {} })).status, 200);
  assert.equal((await f.call('/app-api/overview', { session })).status, 401);
});

test('painel bloqueia CSRF, origem externa e leitura cross-site', async t => {
  const f = await setup(t); const session = await f.login();
  assert.equal((await f.call('/app-api/logout', { session, body: {}, headers: { 'x-csrf-token': 'invalid' } })).status, 403);
  assert.equal((await f.call('/app-api/logout', { session, body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/app-api/overview', { session, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.call('/app-api/demo', { body: {} })).status, 403);
});

test('sessões isoladas não confirmam cobrança nem finalizam saque de outra loja', async t => {
  const f = await setup(t); const a = await f.login(); const b = await f.login();
  const aa = (await f.call('/app-api/overview', { session: a })).body;
  const bb = (await f.call('/app-api/overview', { session: b })).body;
  assert.notEqual(aa.merchant.id, bb.merchant.id);
  assert.equal((await f.call('/app-api/simulate-payment', { session: b, body: { id: aa.payments[0].id } })).status, 404);
  const withdrawal = await f.call('/app-api/withdrawals', { session: a, body: { amountCents: 1000, currency: 'BRL', destinationId: aa.destinations[0].id }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(withdrawal.status, 201);
  assert.equal((await f.call('/app-api/simulate-withdrawal', { session: b, body: { id: withdrawal.body.withdrawal.id, status: 'succeeded' } })).status, 404);
});

test('painel cria cartão, confirma, liquida e devolve saque após falha', async t => {
  const f = await setup(t); const session = await f.login();
  const before = (await f.call('/app-api/overview', { session })).body;
  const created = await f.call('/app-api/payments', { session, body: { amountCents: 10000, currency: 'BRL', method: 'card', cardToken: 'tok_sandbox_1234567890123456' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(created.status, 201);
  assert.equal((await f.call('/app-api/simulate-payment', { session, body: { id: created.body.payment.id } })).status, 200);
  const credited = (await f.call('/app-api/overview', { session })).body;
  assert.equal(credited.wallet.availableCents, before.wallet.availableCents + 9562);
  const w = await f.call('/app-api/withdrawals', { session, body: { amountCents: 5000, currency: 'BRL', destinationId: before.destinations[0].id }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(w.status, 201);
  await f.call('/app-api/simulate-withdrawal', { session, body: { id: w.body.withdrawal.id, status: 'failed' } });
  assert.equal((await f.call('/app-api/overview', { session })).body.wallet.availableCents, credited.wallet.availableCents);
});
