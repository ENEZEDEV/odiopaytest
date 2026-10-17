import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoTestReader, mercadoPagoCents } from '../src/mercadopago.js';

const accessToken = 'TEST-fictitious_credential_only';
const expected = { collectorId: '456', externalReference: 'order-local-1', amountCents: 10010, method: 'pix' };
const valid = { id: 123, collector_id: 456, external_reference: 'order-local-1', transaction_amount: 100.10,
  transaction_amount_refunded: 0, currency_id: 'BRL', payment_method_id: 'pix', payment_type_id: 'bank_transfer', status: 'approved', live_mode: false };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const reader = body => new MercadoPagoTestReader({ accessToken, fetchImpl: async () => json(body) });

test('consulta MP restringe host, redirects e retorno, sem liberar saldo', async () => {
  let calls = 0;
  const client = new MercadoPagoTestReader({ accessToken, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.mercadopago.com/v1/payments/123');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
    return json({ ...valid, payer: { email: 'private@example.test' }, card: { private: 'data' } });
  } });
  const result = await client.getPayment('123', expected);
  assert.equal(result.amountCents, 10010); assert.equal(result.providerStatus, 'approved');
  assert.equal(result.payer, undefined); assert.equal(result.card, undefined);
  assert.equal(result.availableCents, undefined); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(client).includes(accessToken));
});

for (const [field, value] of Object.entries({ id: 124, collector_id: 789, external_reference: 'other', currency_id: 'USD', transaction_amount: '100.11', payment_method_id: 'boleto' })) {
  test(`consulta MP rejeita divergência em ${field}`, async () => {
    await assert.rejects(reader({ ...valid, [field]: value }).getPayment('123', expected), { code: 'mp_payment_mismatch' });
  });
}
for (const live_mode of [true, undefined]) test(`consulta MP exige live_mode false: ${live_mode}`, async () => {
  await assert.rejects(reader({ ...valid, live_mode }).getPayment('123', expected), { code: 'mp_non_test_payment' });
});
for (const status of ['refunded', 'charged_back', 'in_mediation', 'pending', 'authorized']) test(`consulta MP preserva estado ${status}`, async () => {
  assert.equal((await reader({ ...valid, status }).getPayment('123', expected)).providerStatus, status);
});
test('consulta MP preserva estorno parcial sem converter aprovado em saldo', async () => {
  const result = await reader({ ...valid, transaction_amount_refunded: '10.01' }).getPayment('123', expected);
  assert.equal(result.refundedCents, 1001);
});
test('consulta MP aceita cartão e bloqueia estado desconhecido', async () => {
  assert.equal((await reader({ ...valid, payment_method_id: 'visa', payment_type_id: 'credit_card' }).getPayment('123', { ...expected, method: 'card' })).method, 'card');
  await assert.rejects(reader({ ...valid, status: 'new_state' }).getPayment('123', expected), { code: 'mp_unknown_status' });
});
test('consulta MP não faz requisição com ID injetado ou credencial produtiva', async () => {
  assert.throws(() => new MercadoPagoTestReader({ accessToken: 'APP_USR-secret' }), { code: 'mp_test_credentials_required' });
  const client = new MercadoPagoTestReader({ accessToken, fetchImpl: () => assert.fail('não chamar rede') });
  for (const id of ['../users/me', '123?x=y', 'https://evil.test', 9007199254740992]) {
    await assert.rejects(client.getPayment(id, expected), { code: 'mp_invalid_identifier' });
  }
});
for (const [status, code] of [[401, 'mp_access_denied'], [403, 'mp_access_denied'], [404, 'mp_payment_not_found'], [429, 'mp_rate_limited'], [500, 'mp_unavailable']]) {
  test(`consulta MP sanitiza HTTP ${status}, sem retentativa automática`, async () => {
    let calls = 0;
    const client = new MercadoPagoTestReader({ accessToken, fetchImpl: async () => { calls++; return new Response(accessToken, { status }); } });
    await assert.rejects(client.getPayment('123', expected), { code, message: code }); assert.equal(calls, 1);
  });
}
test('consulta MP limita tamanho e rejeita JSON inválido e HTML', async () => {
  for (const response of [new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } }),
    new Response('{', { headers: { 'content-type': 'application/json' } }), new Response('<html>')]) {
    const client = new MercadoPagoTestReader({ accessToken, fetchImpl: async () => response });
    await assert.rejects(client.getPayment('123', expected), e => ['mp_invalid_response', 'mp_response_too_large'].includes(e.code));
  }
});
test('consulta MP encerra timeout antes dos headers e durante o corpo', async () => {
  for (const phase of ['headers', 'body']) {
    const client = new MercadoPagoTestReader({ accessToken, timeoutMs: 20, fetchImpl: async (_url, { signal }) => {
      if (phase === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(accessToken)), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error(accessToken)), { once: true });
      } }), { headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(client.getPayment('123', expected), { code: 'mp_timeout', message: 'mp_timeout' });
  }
});
test('consulta MP oculta erro de rede e rejeita redirecionamento do fetch', async () => {
  const client = new MercadoPagoTestReader({ accessToken, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error'); throw new Error(`redirect failed ${accessToken}`);
  } });
  await assert.rejects(client.getPayment('123', expected), { code: 'mp_unavailable', message: 'mp_unavailable' });
});
test('conversão de dinheiro é exata e rejeita formatos ambíguos', () => {
  for (const [input, output] of [['0.01', 1], [100.1, 10010], ['1', 100], ['9999999999999.99', 999999999999999]]) assert.equal(mercadoPagoCents(input), output);
  for (const input of [null, -1, '1e3', '01.00', '1.001', '1,00', Infinity, {}, '999999999999999.99']) assert.throws(() => mercadoPagoCents(input), { code: 'mp_invalid_amount' });
});
