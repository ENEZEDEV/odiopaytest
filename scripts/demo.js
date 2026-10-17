import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { provisionMerchant, signWebhook } from '../src/security.js';
import { SandboxProvider } from '../src/provider.js';
import { Payments } from '../src/payments.js';
import { createApi } from '../src/http.js';
import { Wallet } from '../src/wallet.js';

const db = openDatabase();
const provider = new SandboxProvider(db);
const wallet = new Wallet(db);
const secret = randomBytes(32).toString('hex');
const merchant = provisionMerchant(db, 'Loja demonstração');
const server = createApi({ db, payments: new Payments(db, provider), webhookSecret: secret });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const method of ['pix', 'card']) {
    const response = await fetch(`${base}/v1/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchant.apiKey}`, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ amountCents: 10_000, currency: 'BRL', method, ...(method === 'card' ? { cardToken: 'tok_sandbox_demo_1234567890123456' } : {}) })
    });
    assert.equal(response.status, 201);
    const { payment } = await response.json();
    provider.settle(payment.providerId, 'succeeded');
    const event = { id: randomUUID(), paymentId: payment.id, providerId: payment.providerId, merchantId: merchant.id, amountCents: payment.amountCents, currency: 'BRL', method, status: 'succeeded' };
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const confirmation = await fetch(`${base}/v1/webhooks/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-odiopay-timestamp': timestamp, 'x-odiopay-signature': signWebhook(secret, timestamp, body) }, body });
    assert.equal(confirmation.status, 200);
    const query = await fetch(`${base}/v1/payments/${payment.id}`, { headers: { authorization: `Bearer ${merchant.apiKey}` } });
    const result = await query.json();
    assert.equal(result.payment.status, 'succeeded');
    assert.equal(wallet.balance(merchant.id).receivableCents, result.payment.netCents);
    wallet.settlePayment(payment.id);
    console.log(JSON.stringify(result.payment, null, 2));
  }
  const before = wallet.balance(merchant.id);
  const response = await fetch(`${base}/v1/withdrawals`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${merchant.apiKey}`, 'idempotency-key': randomUUID()
  }, body: JSON.stringify({ amountCents: 5000, currency: 'BRL', destinationId: merchant.destinationId }) });
  assert.equal(response.status, 201);
  const { withdrawal } = await response.json();
  assert.equal(wallet.balance(merchant.id).availableCents, before.availableCents - 5000);
  wallet.finishWithdrawal(withdrawal.id, 'succeeded');
  assert.equal(wallet.balance(merchant.id).withdrawnCents, 5000);
  console.log(JSON.stringify({ wallet: wallet.balance(merchant.id), withdrawal: wallet.get(merchant.id, withdrawal.id) }, null, 2));
  console.log('Demonstração aprovada: Pix, cartão, liquidação, saldo e saque simulados; sem dinheiro real.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
