import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MercadoPagoTestMarketplace } from '../src/mp-marketplace.js';
import { openDatabase } from '../src/database.js';
import { provisionMerchant } from '../src/security.js';
import { MercadoPagoOAuth } from '../src/mp-oauth.js';
import { randomBytes } from 'node:crypto';

const merchantId = randomUUID();
const intent = { paymentId: randomUUID(), idempotencyKey: randomUUID(), amountCents: 10010, commissionCents: 101, method: 'pix' };
const checkout = { payerEmail: 'test@example.test' };
const connections = { withConnection: async (id, action) => {
  assert.equal(id, merchantId); return action({ accessToken: 'TEST-fake_access_token_123', sellerId: '123' });
} };
function response(order, overrides = {}) {
  return new Response(JSON.stringify({ id: 987, collector_id: 123, transaction_amount: order.transaction_amount,
    transaction_amount_refunded: 0, currency_id: 'BRL', external_reference: order.external_reference,
    payment_method_id: order.payment_method_id, payment_type_id: order.token ? 'credit_card' : 'bank_transfer',
    status: 'pending', live_mode: false, ...overrides }), { headers: { 'content-type': 'application/json' } });
}
for (const method of ['pix', 'card']) test(`marketplace cria ${method} com token do lojista, fee exata e chave estável`, async () => {
  const client = new MercadoPagoTestMarketplace({ connections, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.mercadopago.com/v1/payments');
    assert.equal(options.headers['X-Idempotency-Key'], intent.idempotencyKey);
    assert.equal(options.headers.Authorization, 'Bearer TEST-fake_access_token_123');
    assert.match(options.body, /"transaction_amount":100\.10/); assert.match(options.body, /"application_fee":1\.01/);
    const order = JSON.parse(options.body);
    assert.equal(order.external_reference, intent.paymentId); assert.equal(order.installments, method === 'card' ? 1 : undefined);
    return response(order);
  } });
  const result = await client.create(merchantId, { ...intent, method }, { ...checkout,
    ...(method === 'card' ? { cardToken: 'fake_single_use_token_123', paymentMethodId: 'visa' } : {}) });
  assert.equal(result.providerStatus, 'pending'); assert.equal(result.amountCents, 10010);
  assert.equal(result.accessToken, undefined); assert.equal(result.availableCents, undefined);
});
test('marketplace bloqueia fee, recebedor e dados crus injetados pelo checkout', async () => {
  const client = new MercadoPagoTestMarketplace({ connections, fetchImpl: () => assert.fail('não chamar rede') });
  for (const extra of [{ application_fee: 0 }, { collector_id: 456 }, { cardNumber: 'fake-pan' }, { cvv: 'fake-cvv' }]) {
    await assert.rejects(client.create(merchantId, intent, { ...checkout, ...extra }), { code: 'unexpected_field' });
  }
  for (const commissionCents of [-1, 1.1, 10010, '100']) await assert.rejects(client.create(merchantId, { ...intent, commissionCents }, checkout), { code: 'mp_invalid_commission' });
});
test('marketplace não tenta novamente quando envio tem resultado incerto', async () => {
  let calls = 0; const client = new MercadoPagoTestMarketplace({ connections, fetchImpl: async () => { calls++; throw new Error('network'); } });
  await assert.rejects(client.create(merchantId, intent, checkout), { code: 'mp_unavailable' }); assert.equal(calls, 1);
});
test('marketplace rejeita produção ou conta diferente na resposta', async () => {
  for (const [overrides, code] of [[{ live_mode: true }, 'mp_non_test_payment'], [{ collector_id: 456 }, 'mp_payment_mismatch']]) {
    const client = new MercadoPagoTestMarketplace({ connections, fetchImpl: async (_url, options) => response(JSON.parse(options.body), overrides) });
    await assert.rejects(client.create(merchantId, intent, checkout), { code });
  }
});
test('marketplace usa conexão OAuth cifrada e desconexão bloqueia pagamentos', async t => {
  const db = openDatabase(); t.after(() => db.close()); const localMerchant = provisionMerchant(db, 'Loja OAuth').id;
  let paymentCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'TEST-connected_access_123',
      refresh_token: 'fake_refresh_connected_123', public_key: 'TEST-public-example', user_id: '123', token_type: 'bearer',
      expires_in: 3600, live_mode: false, scope: 'offline_access read write' }), { headers: { 'content-type': 'application/json' } });
    paymentCalls++; assert.equal(options.headers.Authorization, 'Bearer TEST-connected_access_123');
    return response(JSON.parse(options.body));
  };
  const oauth = new MercadoPagoOAuth({ db, encryptionKey: randomBytes(32), clientId: '123', clientSecret: 'fake_client_secret_123',
    redirectUri: 'https://odiopay.example/callback', fetchImpl });
  const sessionBinding = 'bound-server-session-123456789012345';
  const start = new URL(oauth.begin(localMerchant, sessionBinding).authorizationUrl);
  await oauth.complete({ merchantId: localMerchant, sessionBinding, state: start.searchParams.get('state'), code: 'fake-code' });
  const client = new MercadoPagoTestMarketplace({ connections: oauth, fetchImpl });
  assert.equal((await client.create(localMerchant, intent, checkout)).collectorId, '123');
  oauth.disconnect(localMerchant);
  await assert.rejects(client.create(localMerchant, intent, checkout), { code: 'mp_connection_unavailable' });
  assert.equal(paymentCalls, 1);
});
