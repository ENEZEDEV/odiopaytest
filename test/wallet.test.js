import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/database.js';
import { provisionMerchant } from '../src/security.js';
import { SandboxProvider } from '../src/provider.js';
import { Payments } from '../src/payments.js';
import { Wallet } from '../src/wallet.js';
import { createApi } from '../src/http.js';

function setup(t, path) {
  const db = openDatabase(path);
  t.after(() => db.close());
  const merchant = { ...provisionMerchant(db, 'Loja carteira'), plan: 'standard' };
  const provider = new SandboxProvider(db);
  const payments = new Payments(db, provider);
  const wallet = new Wallet(db);
  const payment = payments.create(merchant, { amountCents: 10000, currency: 'BRL', method: 'pix' }, randomUUID()).payment;
  function confirm() {
    provider.settle(payment.providerId, 'succeeded');
    payments.confirm({ id: randomUUID(), paymentId: payment.id, providerId: payment.providerId, merchantId: merchant.id, amountCents: 10000, currency: 'BRL', method: 'pix', status: 'succeeded' });
  }
  function fund() { confirm(); wallet.settlePayment(payment.id); }
  const input = amountCents => ({ amountCents, currency: 'BRL', destinationId: merchant.destinationId });
  return { db, merchant, provider, payments, wallet, payment, confirm, fund, input };
}

test('saldo só fica disponível após liquidação, com desconto da tarifa', t => {
  const f = setup(t);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 0);
  assert.throws(() => f.wallet.settlePayment(f.payment.id), { code: 'payment_not_confirmed' });
  f.confirm();
  assert.equal(f.wallet.balance(f.merchant.id).receivableCents, 9900);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 0);
  assert.throws(() => f.wallet.request(f.merchant.id, f.input(100), randomUUID()), { code: 'insufficient_balance' });
  assert.equal(f.wallet.settlePayment(f.payment.id).replayed, false);
  assert.equal(f.wallet.settlePayment(f.payment.id).replayed, true);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 9900);
  assert.equal(f.wallet.balance(f.merchant.id).receivableCents, 0);
});

test('reserva reduz disponível, sucesso consome reserva e falha devolve saldo', t => {
  const f = setup(t); f.fund();
  const a = f.wallet.request(f.merchant.id, f.input(4000), randomUUID()).withdrawal;
  let balance = f.wallet.balance(f.merchant.id);
  assert.equal(balance.availableCents, 5900);
  assert.equal(balance.reservedCents, 4000);
  f.wallet.finishWithdrawal(a.id, 'succeeded');
  const b = f.wallet.request(f.merchant.id, f.input(5000), randomUUID()).withdrawal;
  f.wallet.finishWithdrawal(b.id, 'failed');
  balance = f.wallet.balance(f.merchant.id);
  assert.equal(balance.availableCents, 5900);
  assert.equal(balance.reservedCents, 0);
  assert.equal(balance.withdrawnCents, 4000);
  assert.equal(balance.availableCents + balance.reservedCents + balance.withdrawnCents, 9900);
});

test('saque repetido não reserva duas vezes, conflito não altera saldo', t => {
  const f = setup(t); f.fund();
  const key = randomUUID();
  const first = f.wallet.request(f.merchant.id, f.input(5000), key);
  assert.equal(f.wallet.request(f.merchant.id, f.input(5000), key).withdrawal.id, first.withdrawal.id);
  assert.throws(() => f.wallet.request(f.merchant.id, f.input(5001), key), { code: 'idempotency_conflict' });
  assert.equal(f.wallet.balance(f.merchant.id).reservedCents, 5000);
  f.wallet.finishWithdrawal(first.withdrawal.id, 'succeeded');
  assert.equal(f.wallet.finishWithdrawal(first.withdrawal.id, 'succeeded').replayed, true);
  assert.throws(() => f.wallet.finishWithdrawal(first.withdrawal.id, 'failed'), { code: 'invalid_transition' });
  assert.equal(f.wallet.balance(f.merchant.id).withdrawnCents, 5000);
});

test('saldo insuficiente e valores inválidos são rejeitados sem reserva', t => {
  const f = setup(t); f.fund();
  assert.throws(() => f.wallet.request(f.merchant.id, f.input(9901), randomUUID()), { code: 'insufficient_balance' });
  for (const amount of [-1, 0, 99, 1.5, '100', 100000001]) assert.throws(() => f.wallet.request(f.merchant.id, f.input(amount), randomUUID()), { code: 'invalid_amount' });
  for (const extra of [{ status: 'succeeded' }, { availableCents: 1000000 }, { merchantId: randomUUID() }, { feeCents: 0 }]) assert.throws(() => f.wallet.request(f.merchant.id, { ...f.input(100), ...extra }, randomUUID()), { code: 'unexpected_field' });
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 9900);
  assert.equal(f.wallet.list(f.merchant.id).length, 0);
});

test('destino e saque de outro lojista não são acessíveis; destino revogado bloqueia novo saque', t => {
  const f = setup(t); f.fund();
  const other = provisionMerchant(f.db, 'Outra loja');
  assert.throws(() => f.wallet.request(f.merchant.id, { ...f.input(100), destinationId: other.destinationId }, randomUUID()), { code: 'destination_not_found' });
  const w = f.wallet.request(f.merchant.id, f.input(100), randomUUID()).withdrawal;
  assert.throws(() => f.wallet.get(other.id, w.id), { status: 404 });
  assert.equal(f.wallet.list(other.id).length, 0);
  assert.equal(f.wallet.balance(other.id).availableCents, 0);
  f.db.prepare('UPDATE sandbox_destinations SET revoked=1 WHERE id=?').run(f.merchant.destinationId);
  assert.throws(() => f.wallet.request(f.merchant.id, f.input(100), randomUUID()), { code: 'destination_not_found' });
});

test('falha no diário desfaz reserva e criação do saque', t => {
  const f = setup(t); f.fund();
  f.db.exec("CREATE TRIGGER fail_reserve BEFORE INSERT ON wallet_journal WHEN NEW.action='reserved' BEGIN SELECT RAISE(ABORT,'injected_failure'); END;");
  assert.throws(() => f.wallet.request(f.merchant.id, f.input(100), randomUUID()), /injected_failure/);
  assert.equal(f.wallet.list(f.merchant.id).length, 0);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 9900);
});

test('falha no diário desfaz liquidação e permite retentar', t => {
  const f = setup(t); f.confirm();
  f.db.exec("CREATE TRIGGER fail_settle BEFORE INSERT ON wallet_journal WHEN NEW.action='settled' BEGIN SELECT RAISE(ABORT,'injected_failure'); END;");
  assert.throws(() => f.wallet.settlePayment(f.payment.id), /injected_failure/);
  assert.equal(f.wallet.balance(f.merchant.id).receivableCents, 9900);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 0);
  f.db.exec('DROP TRIGGER fail_settle');
  f.wallet.settlePayment(f.payment.id);
  assert.equal(f.wallet.balance(f.merchant.id).availableCents, 9900);
});

test('falha ao finalizar mantém reserva; timeout não é um resultado definitivo', t => {
  const f = setup(t); f.fund();
  const w = f.wallet.request(f.merchant.id, f.input(1000), randomUUID()).withdrawal;
  assert.throws(() => f.wallet.finishWithdrawal(w.id, 'timeout'), { code: 'invalid_withdrawal_status' });
  f.db.exec("CREATE TRIGGER fail_finish BEFORE INSERT ON wallet_journal WHEN NEW.action='succeeded' BEGIN SELECT RAISE(ABORT,'injected_failure'); END;");
  assert.throws(() => f.wallet.finishWithdrawal(w.id, 'succeeded'), /injected_failure/);
  assert.equal(f.wallet.get(f.merchant.id, w.id).status, 'reserved');
  assert.equal(f.wallet.balance(f.merchant.id).reservedCents, 1000);
});

test('diário rejeita alteração e exclusão pelo SQL normal', t => {
  const f = setup(t); f.fund();
  assert.throws(() => f.db.exec('UPDATE wallet_journal SET available_delta=999999'), /journal_is_append_only/);
  assert.throws(() => f.db.exec('DELETE FROM wallet_journal'), /journal_is_append_only/);
});

test('API isola carteira e saques e não oferece rota para criar saldo', async t => {
  const f = setup(t); f.fund();
  const server = createApi({ db: f.db, payments: f.payments, webhookSecret: randomBytes(32).toString('hex') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${f.merchant.apiKey}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  const result = await fetch(`${base}/v1/withdrawals`, { method: 'POST', headers, body: JSON.stringify(f.input(1000)) });
  assert.equal(result.status, 201);
  const { withdrawal } = await result.json();
  const other = provisionMerchant(f.db, 'Outra loja API');
  const otherHeaders = { authorization: `Bearer ${other.apiKey}` };
  assert.equal((await fetch(`${base}/v1/withdrawals/${withdrawal.id}`, { headers: otherHeaders })).status, 404);
  assert.equal((await fetch(`${base}/v1/withdrawals/${withdrawal.id}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/v1/wallet`)).status, 401);
  assert.equal((await fetch(`${base}/v1/wallet`, { method: 'POST', headers, body: '{}' })).status, 404);
  const balance = await (await fetch(`${base}/v1/wallet`, { headers: otherHeaders })).json();
  assert.equal(balance.wallet.availableCents, 0);
});

test('oito saques concorrentes não gastam o mesmo saldo', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'odiopay-withdrawals-'));
  const path = join(dir, 'wallet.sqlite');
  const db = openDatabase(path);
  const merchant = { ...provisionMerchant(db, 'Concorrência de saques'), plan: 'standard' };
  const provider = new SandboxProvider(db);
  const payments = new Payments(db, provider);
  const wallet = new Wallet(db);
  const p = payments.create(merchant, { amountCents: 10000, currency: 'BRL', method: 'pix' }, randomUUID()).payment;
  provider.settle(p.providerId, 'succeeded');
  payments.confirm({ id: randomUUID(), paymentId: p.id, providerId: p.providerId, merchantId: merchant.id, amountCents: 10000, currency: 'BRL', method: 'pix', status: 'succeeded' });
  wallet.settlePayment(p.id);
  db.close();
  t.after(() => rmSync(dir, { recursive: true }));
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../scripts/withdrawal-worker.js', import.meta.url), { workerData: { path, merchant } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve(result) : reject(new Error(`worker exit ${code}`)));
  })));
  assert.equal(results.filter(r => r.accepted).length, 1);
  assert.equal(results.filter(r => r.code === 'insufficient_balance').length, 7);
  const reopened = openDatabase(path);
  try {
    const w = new Wallet(reopened);
    assert.equal(w.balance(merchant.id).availableCents, 0);
    assert.equal(w.balance(merchant.id).reservedCents, 9900);
    const withdrawal = w.list(merchant.id)[0];
    w.finishWithdrawal(withdrawal.id, 'succeeded');
    assert.equal(w.balance(merchant.id).withdrawnCents, 9900);
  } finally { reopened.close(); }
});
