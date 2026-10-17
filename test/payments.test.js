import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/database.js';
import { provisionMerchant, authenticate, digest, signWebhook, RateLimiter } from '../src/security.js';
import { SandboxProvider } from '../src/provider.js';
import { Payments, calculateFee } from '../src/payments.js';
import { createApi } from '../src/http.js';
import { config } from '../src/config.js';

const pix = { amountCents: 10000, currency: 'BRL', method: 'pix' };
const card = { ...pix, method: 'card', cardToken: 'tok_sandbox_1234567890123456' };

function setup(t, path) {
  const db = openDatabase(path);
  const credentials = provisionMerchant(db, 'Loja A');
  const merchant = authenticate(db, `Bearer ${credentials.apiKey}`);
  const provider = new SandboxProvider(db);
  const payments = new Payments(db, provider);
  t.after(() => db.close());
  return { db, credentials, merchant, provider, payments };
}

function eventFor(f, payment, status = 'succeeded') {
  return { id: randomUUID(), paymentId: payment.id, providerId: payment.providerId, merchantId: f.merchant.id, amountCents: payment.amountCents, currency: 'BRL', method: payment.method, status };
}

for (const input of [pix, card]) test(`cria ${input.method} e confirma com lançamentos balanceados`, t => {
  const f = setup(t);
  const { payment } = f.payments.create(f.merchant, input, randomUUID());
  assert.equal(payment.status, 'pending');
  f.provider.settle(payment.providerId, 'succeeded');
  assert.deepEqual(f.payments.confirm(eventFor(f, payment)), { accepted: true, replayed: false });
  assert.equal(f.payments.get(f.merchant.id, payment.id).status, 'succeeded');
  assert.equal(f.db.prepare('SELECT SUM(amount_cents) AS total FROM accounting_entries').get().total, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 3);
});

test('repetição da criação retorna uma única cobrança; alteração gera conflito', t => {
  const f = setup(t);
  const key = randomUUID();
  const first = f.payments.create(f.merchant, pix, key);
  const retry = f.payments.create(f.merchant, { method: 'pix', currency: 'BRL', amountCents: 10000 }, key);
  assert.equal(first.payment.id, retry.payment.id);
  assert.equal(retry.replayed, true);
  assert.throws(() => f.payments.create(f.merchant, { ...pix, amountCents: 10001 }, key), { code: 'idempotency_conflict' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_payments').get().n, 1);
});

test('acesso e listagem são isolados por lojista; mesma chave pode ser usada por outro lojista', t => {
  const f = setup(t);
  const other = provisionMerchant(f.db, 'Loja B');
  const key = randomUUID();
  const a = f.payments.create(f.merchant, pix, key).payment;
  const b = f.payments.create({ id: other.id, plan: 'standard' }, pix, key).payment;
  assert.notEqual(a.id, b.id);
  assert.throws(() => f.payments.get(other.id, a.id), { status: 404 });
  assert.deepEqual(f.payments.list(other.id).map(p => p.id), [b.id]);
  assert.throws(() => f.payments.get(other.id, "' OR 1=1 --"), { status: 404 });
});

for (const amount of [-1, 0, 99, 1.5, '10000', null, 100000001, Number.MAX_SAFE_INTEGER]) test(`rejeita valor inválido ${String(amount)}`, t => {
  const f = setup(t);
  assert.throws(() => f.payments.create(f.merchant, { ...pix, amountCents: amount }, randomUUID()), { code: 'invalid_amount' });
  assert.equal(f.payments.list(f.merchant.id).length, 0);
});

for (const extra of [{ feeCents: 0 }, { status: 'succeeded' }, { merchantId: randomUUID() }, { plan: 'pro' }, { cardNumber: '4111111111111111', cvv: '123' }]) test(`bloqueia campo controlado pelo cliente: ${Object.keys(extra)[0]}`, t => {
  const f = setup(t);
  assert.throws(() => f.payments.create(f.merchant, { ...pix, ...extra }, randomUUID()), { code: 'unexpected_field' });
});

test('rejeita moeda, método, cartão sem token e token em cobrança Pix', t => {
  const f = setup(t);
  for (const input of [{ ...pix, currency: 'USD' }, { ...pix, method: 'boleto' }, { ...pix, method: 'card' }, { ...pix, cardToken: card.cardToken }, null, []]) {
    assert.throws(() => f.payments.create(f.merchant, input, randomUUID()), error => error.status === 400);
  }
  assert.throws(() => f.payments.create(f.merchant, pix, 'short'), { code: 'invalid_idempotency_key' });
});

test('tarifa usa centavos e arredondamento definido; plano vem do servidor', t => {
  const f = setup(t);
  assert.equal(calculateFee(10000, 'card', 'standard'), 438);
  assert.equal(calculateFee(10001, 'card', 'standard'), 439);
  assert.equal(calculateFee(10000, 'pix', 'standard'), 100);
  assert.equal(calculateFee(10000, 'pix', 'pro'), 50);
  for (let amount = 100; amount < 100000; amount += 113) {
    const fee = calculateFee(amount, 'card', 'pro');
    assert.equal(Number.isSafeInteger(fee), true);
    assert.ok(fee >= 0 && fee <= amount);
  }
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  f.db.prepare("UPDATE merchants SET plan='pro' WHERE id=?").run(f.merchant.id);
  assert.equal(f.payments.get(f.merchant.id, p.id).feeCents, 100);
});

test('evento válido exige confirmação independente no processador', t => {
  const f = setup(t);
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  assert.throws(() => f.payments.confirm(eventFor(f, p)), { code: 'provider_not_confirmed' });
  assert.equal(f.payments.get(f.merchant.id, p.id).status, 'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('adulteração de valor, moeda, método, lojista e identificador é rejeitada', t => {
  const f = setup(t);
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  f.provider.settle(p.providerId, 'succeeded');
  for (const change of [{ amountCents: 10001 }, { currency: 'USD' }, { method: 'card' }, { merchantId: randomUUID() }, { providerId: randomUUID() }]) {
    assert.throws(() => f.payments.confirm({ ...eventFor(f, p), ...change }), error => [400, 409].includes(error.status));
  }
  assert.equal(f.payments.get(f.merchant.id, p.id).status, 'pending');
});

test('eventos repetidos e novos IDs não duplicam lançamentos', t => {
  const f = setup(t);
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  f.provider.settle(p.providerId, 'succeeded');
  const event = eventFor(f, p);
  f.payments.confirm(event);
  assert.equal(f.payments.confirm(event).replayed, true);
  assert.equal(f.payments.confirm({ ...event, id: randomUUID() }).replayed, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 2);
  assert.throws(() => f.payments.confirm({ ...event, amountCents: 10001 }), { code: 'event_conflict' });
});

test('pagamento recusado não gera lançamentos; status final não regride', t => {
  const f = setup(t);
  const p = f.payments.create(f.merchant, card, randomUUID()).payment;
  f.provider.settle(p.providerId, 'failed');
  f.payments.confirm(eventFor(f, p, 'failed'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 0);
  assert.throws(() => f.provider.settle(p.providerId, 'succeeded'), { code: 'provider_not_pending' });
  f.db.prepare("UPDATE provider_payments SET status='succeeded' WHERE id=?").run(p.providerId);
  assert.throws(() => f.payments.confirm(eventFor(f, p)), { code: 'invalid_transition' });
});

test('falha durante lançamento reverte status, evento e contabilização', t => {
  const f = setup(t);
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  f.provider.settle(p.providerId, 'succeeded');
  f.db.exec("CREATE TRIGGER fail_entry BEFORE INSERT ON accounting_entries WHEN NEW.account='platform_revenue' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  const event = eventFor(f, p);
  assert.throws(() => f.payments.confirm(event), /injected failure/);
  assert.equal(f.payments.get(f.merchant.id, p.id).status, 'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  f.db.exec('DROP TRIGGER fail_entry');
  f.payments.confirm(event);
  assert.equal(f.payments.get(f.merchant.id, p.id).status, 'succeeded');
});

test('falha na criação reverte também a cobrança do simulador', t => {
  const f = setup(t);
  f.db.exec("CREATE TRIGGER fail_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.throws(() => f.payments.create(f.merchant, pix, randomUUID()));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_payments').get().n, 0);
});

test('chaves são armazenadas com hash, revogação funciona e tokens não são persistidos', t => {
  const f = setup(t);
  f.payments.create(f.merchant, card, randomUUID());
  const all = ['api_keys', 'payments', 'provider_payments', 'audit'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
  const dump = JSON.stringify(all);
  assert.ok(!dump.includes(f.credentials.apiKey));
  assert.ok(!dump.includes(card.cardToken));
  f.db.prepare('UPDATE api_keys SET revoked=1 WHERE digest=?').run(digest(f.credentials.apiKey));
  assert.throws(() => authenticate(f.db, `Bearer ${f.credentials.apiKey}`), { status: 401 });
});

async function httpFixture(t, options = {}) {
  const f = setup(t);
  const secret = randomBytes(32).toString('hex');
  const logs = [];
  const server = createApi({ ...f, webhookSecret: secret, logger: entry => logs.push(entry), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, { method = 'GET', input, headers = {}, raw, auth = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { ...(auth ? { authorization: `Bearer ${f.credentials.apiKey}` } : {}), ...(input !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (input !== undefined ? JSON.stringify(input) : undefined) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const webhook = (event, changes = {}) => {
    const raw = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return request('/v1/webhooks/sandbox', { method: 'POST', raw, auth: false, headers: { 'x-odiopay-timestamp': timestamp, 'x-odiopay-signature': signWebhook(secret, timestamp, raw), ...changes } });
  };
  return { ...f, server, secret, logs, request, webhook };
}

test('API exige autenticação e rejeita tentativas de origem externa', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/v1/payments', { auth: false })).status, 401);
  assert.equal((await f.request('/v1/payments', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await f.request('/v1/payments', { headers: { origin: 'https://evil.example' } })).status, 403);
  const good = await f.request('/v1/payments');
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal(good.headers.get('access-control-allow-origin'), null);
});

test('API Pix completa e 20 pedidos simultâneos geram uma cobrança', async t => {
  const f = await httpFixture(t);
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.request('/v1/payments', { method: 'POST', input: pix, headers: { 'idempotency-key': key } })));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(new Set(responses.map(r => r.body.payment.id)).size, 1);
  const p = responses[0].body.payment;
  f.provider.settle(p.providerId, 'succeeded');
  const event = eventFor(f, p);
  const confirmations = await Promise.all(Array.from({ length: 20 }, () => f.webhook(event)));
  assert.ok(confirmations.every(r => r.status === 200));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 3);
});

test('webhook rejeita assinatura falsa, corpo adulterado, timestamp antigo e futuro', async t => {
  const f = await httpFixture(t);
  const p = f.payments.create(f.merchant, pix, randomUUID()).payment;
  f.provider.settle(p.providerId, 'succeeded');
  const event = eventFor(f, p);
  assert.equal((await f.webhook(event, { 'x-odiopay-signature': '0'.repeat(64) })).status, 401);
  // Keep a margin from the 300-second boundary so a clock tick cannot make
  // the future timestamp valid while the HTTP request is in flight.
  for (const offset of [-600, 600]) {
    const timestamp = String(Math.floor(Date.now() / 1000) + offset);
    assert.equal((await f.webhook(event, { 'x-odiopay-timestamp': timestamp, 'x-odiopay-signature': signWebhook(f.secret, timestamp, JSON.stringify(event)) })).status, 401);
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal((await f.webhook({ ...event, amountCents: 20000 }, { 'x-odiopay-signature': signWebhook(f.secret, timestamp, JSON.stringify(event)) })).status, 401);
  assert.equal(f.payments.get(f.merchant.id, p.id).status, 'pending');
});

test('API rejeita JSON inválido, corpo grande, tipo incorreto e campos de cartão', async t => {
  const f = await httpFixture(t);
  const post = options => f.request('/v1/payments', { method: 'POST', headers: { 'idempotency-key': randomUUID() }, ...options });
  assert.equal((await post({ raw: '{broken' })).status, 400);
  assert.equal((await post({ raw: 'x'.repeat(17000) })).status, 413);
  assert.equal((await post({ raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post({ input: { ...pix, cvv: '123' } })).status, 400);
});

test('limite de requisições não confia no X-Forwarded-For', async t => {
  const f = await httpFixture(t, { rateLimiter: new RateLimiter(2) });
  assert.equal((await f.request('/health')).status, 200);
  assert.equal((await f.request('/health')).status, 200);
  const limited = await f.request('/health', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('limite de requisições expira e limita memória', () => {
  const limiter = new RateLimiter(1, 1000, 2);
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 1), false);
  assert.equal(limiter.allow('b', 1), true);
  assert.equal(limiter.allow('c', 1), false);
  assert.equal(limiter.allow('c', 1001), true);
});

test('erro interno é sanitizado e logs não contêm dados sensíveis', async t => {
  const f = await httpFixture(t);
  f.db.exec("CREATE TRIGGER fail_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'private database detail'); END;");
  const response = await f.request('/v1/payments', { method: 'POST', input: card, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'internal_error');
  const exposed = JSON.stringify([response.body, f.logs]);
  for (const value of ['private database detail', f.credentials.apiKey, card.cardToken]) assert.ok(!exposed.includes(value));
});

test('produção, segredo ausente e porta inválida impedem inicialização', () => {
  const env = { ODIOPAY_MODE: 'sandbox', ODIOPAY_WEBHOOK_SECRET: 'x'.repeat(64) };
  assert.throws(() => config({ ...env, NODE_ENV: 'production' }), { code: 'sandbox_mode_required' });
  assert.throws(() => config({}), { code: 'sandbox_mode_required' });
  assert.throws(() => config({ ...env, ODIOPAY_WEBHOOK_SECRET: '' }), { code: 'webhook_secret_required' });
  assert.throws(() => config({ ...env, PORT: 'abc' }), { code: 'invalid_port' });
});

test('persistência preserva idempotência após reabrir banco', t => {
  const dir = mkdtempSync(join(tmpdir(), 'odiopay-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let db = openDatabase(path);
  const credentials = provisionMerchant(db, 'Persistência');
  const merchant = authenticate(db, `Bearer ${credentials.apiKey}`);
  const key = randomUUID();
  let provider = new SandboxProvider(db);
  let payments = new Payments(db, provider);
  const p = payments.create(merchant, pix, key).payment;
  provider.settle(p.providerId, 'succeeded');
  const event = eventFor({ merchant }, p);
  payments.confirm(event);
  db.close();
  db = openDatabase(path);
  try {
    provider = new SandboxProvider(db);
    payments = new Payments(db, provider);
    assert.equal(payments.create(merchant, pix, key).payment.id, p.id);
    assert.equal(payments.confirm(event).replayed, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_entries').get().n, 3);
    assert.ok(!readFileSync(path).includes(Buffer.from(credentials.apiKey)));
  } finally { db.close(); }
});

test('oito conexões concorrentes compartilham idempotência persistente', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'odiopay-concurrency-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  const credentials = provisionMerchant(db, 'Concorrência');
  const merchant = authenticate(db, `Bearer ${credentials.apiKey}`);
  db.close();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../scripts/concurrent-worker.js', import.meta.url), { workerData: { path, merchant, key } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve(result) : reject(new Error(`worker exit ${code}`)));
  })));
  assert.equal(new Set(results.map(p => p.payment.id)).size, 1);
  assert.equal(results.filter(p => !p.replayed).length, 1);
});
