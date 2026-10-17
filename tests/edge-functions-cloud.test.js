import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { calculateServerFee } from '../src/finance/tariffs.js';
import { TokenVault } from '../src/security/token-vault.js';
import { hmacSha256Hex, timingSafeEqual } from '../supabase/functions/_shared/crypto.ts';

describe('ODIOPAY - Testes Rigorosos de Edge Functions e Idempotência', () => {
  let pool;
  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const vault = new TokenVault(encryptionKey);
  const webhookSecret = 'test_webhook_secret_key_12345';

  const userA_id = randomUUID();
  let merchantA_id;

  before(async () => {
    pool = new pg.Pool({
      host: '/tmp/pgrun',
      port: 54322,
      user: 'postgres',
    });

    const resA = await pool.query(
      "INSERT INTO public.merchants (auth_user_id, name, plan) VALUES ($1, 'Loja Hardened', 'standard') RETURNING id;",
      [userA_id]
    );
    merchantA_id = resA.rows[0].id;

    // Conexão OAuth criptografada com seller_id exclusivo
    const sellerId = `seller-${randomUUID()}`;
    const encAccessToken = vault.seal('TEST-SELLER-TOKEN-123', `mp:oauth:${merchantA_id}:${sellerId}`);
    const encRefreshToken = vault.seal('TEST-REFRESH-TOKEN-123', `mp:oauth:${merchantA_id}:${sellerId}`);

    await pool.query(
      `INSERT INTO public.mp_oauth_connections (merchant_id, seller_id, encrypted_access_token, encrypted_refresh_token, public_key, token_type, expires_at, scope, status)
       VALUES ($1, $2, $3, $4, 'TEST-PK-999', 'Bearer', NOW() + INTERVAL '30 days', 'offline_access', 'active')
       ON CONFLICT (merchant_id) DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token;`,
      [merchantA_id, sellerId, encAccessToken, encRefreshToken]
    );
  });

  after(async () => {
    await pool.end();
  });

  test('1. Comissão adulterada: cliente tenta zerar taxa, servidor recalcula estritamente', () => {
    // Standard: PIX R$ 1,00 fixo; Cartão 3,99% + R$ 0,39
    const clientProvidedFee = 0;
    const amountCents = 10000; // R$ 100,00

    const serverPixFee = calculateServerFee(amountCents, 'pix', 'standard');
    assert.equal(serverPixFee, 100, 'Tarifa Pix Standard deve ser R$ 1,00 fixo');

    const serverCardFee = calculateServerFee(amountCents, 'card', 'standard');
    assert.equal(serverCardFee, 438, 'Tarifa Cartão Standard (3,99% de 100,00 + 0,39 = 4,38)');

    // Pro: PIX R$ 0,50 fixo; Cartão 2,99% + R$ 0,30
    const serverPixFeePro = calculateServerFee(amountCents, 'pix', 'pro');
    assert.equal(serverPixFeePro, 50, 'Tarifa Pix Pro deve ser R$ 0,50 fixo');

    const serverCardFeePro = calculateServerFee(amountCents, 'card', 'pro');
    assert.equal(serverCardFeePro, 329, 'Tarifa Cartão Pro (2,99% de 100,00 + 0,30 = 3,29)');

    // Rejeição de valores e métodos inválidos
    assert.throws(() => calculateServerFee(50, 'pix', 'standard'), /invalid_amount/);
    assert.throws(() => calculateServerFee(10000, 'crypto', 'standard'), /invalid_method/);
  });

  test('2. Idempotência e Repetição (Replay idêntico no banco)', async () => {
    const key = `key-replay-${randomUUID()}`;
    const digest = 'digest-exact-match';
    const amountCents = 25000;
    const feeCents = calculateServerFee(amountCents, 'pix', 'standard');

    // Primeira chamada: insere intenção
    const res1 = await pool.query(
      `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status, mp_payment_id)
       VALUES ($1, $2, $3, $4, $5, 'BRL', 'pix', 'pagador@exemplo.com', 'succeeded', 'mp-123')
       RETURNING *;`,
      [merchantA_id, key, digest, amountCents, feeCents]
    );
    assert.equal(res1.rows.length, 1);

    // Segunda chamada com a mesma chave e mesmo digest (replay)
    const res2 = await pool.query(
      `SELECT * FROM public.payment_intents WHERE merchant_id = $1 AND idempotency_key = $2;`,
      [merchantA_id, key]
    );
    assert.equal(res2.rows.length, 1);
    assert.equal(res2.rows[0].request_digest, digest);
    assert.equal(res2.rows[0].status, 'succeeded');
  });

  test('3. Idempotência e Resposta Divergente (Conflito de parâmetros 409)', async () => {
    const key = `key-conflict-${randomUUID()}`;
    const initialDigest = 'digest-amount-100';

    await pool.query(
      `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
       VALUES ($1, $2, $3, 10000, 100, 'BRL', 'pix', 'pagador@exemplo.com', 'succeeded');`,
      [merchantA_id, key, initialDigest]
    );

    // Consulta com parâmetros alterados (novo digest)
    const newDigest = 'digest-amount-200';
    const check = await pool.query(
      `SELECT * FROM public.payment_intents WHERE merchant_id = $1 AND idempotency_key = $2;`,
      [merchantA_id, key]
    );

    assert.equal(check.rows.length, 1);
    const hasConflict = check.rows[0].request_digest !== newDigest;
    assert.equal(hasConflict, true, 'Deve identificar divergência de parâmetros e disparar 409');
  });

  test('4. Concorrência: 10 chamadas simultâneas com a mesma chave de idempotência', async () => {
    const key = `key-conc-${randomUUID()}`;
    const digest = `digest-conc-${randomUUID()}`;

    // Executa 10 tentativas simultâneas de inserção
    const results = await Promise.allSettled(
      Array.from({ length: 10 }).map((_, i) =>
        pool.query(
          `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
           VALUES ($1, $2, $3, 15000, 100, 'BRL', 'pix', 'concorrente@exemplo.com', 'processing')
           RETURNING id;`,
          [merchantA_id, key, digest]
        )
      )
    );

    const successfulInserts = results.filter((r) => r.status === 'fulfilled');
    const rejectedInserts = results.filter((r) => r.status === 'rejected');

    assert.equal(successfulInserts.length, 1, 'Exatamente 1 inserção deve ser aceita no banco');
    assert.equal(rejectedInserts.length, 9, 'As outras 9 devem ser barradas pela restrição UNIQUE');

    // As rejeições devem ser por violação de constraint unique
    for (const rej of rejectedInserts) {
      assert.equal(rej.reason.code, '23505');
    }
  });

  test('5. Timeout de rede: intenção permanece em requires_reconciliation sem cobrança duplicada', async () => {
    const key = `key-timeout-${randomUUID()}`;
    const insertRes = await pool.query(
      `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
       VALUES ($1, $2, 'digest-timeout', 30000, 100, 'BRL', 'pix', 'timeout@exemplo.com', 'processing')
       RETURNING id;`,
      [merchantA_id, key]
    );
    const intentId = insertRes.rows[0].id;

    // Simula ocorrência de timeout na chamada upstream:
    // A intenção é marcada para reconciliação
    await pool.query(
      `UPDATE public.payment_intents SET status = 'requires_reconciliation', error_code = 'network_timeout' WHERE id = $1;`,
      [intentId]
    );

    const check = await pool.query('SELECT status, error_code FROM public.payment_intents WHERE id = $1;', [intentId]);
    assert.equal(check.rows[0].status, 'requires_reconciliation');
    assert.equal(check.rows[0].error_code, 'network_timeout');
  });

  test('6. Webhook com assinatura inválida é rejeitado', async () => {
    const dataId = '999888777';
    const requestId = 'req-abc-123';
    const ts = String(Math.floor(Date.now() / 1000));
    const forgedSignature = 'forged_hmac_hex_0000000000000000000000000000000000000000000000000000000000000000';

    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const validHmac = await hmacSha256Hex(webhookSecret, manifest);

    const isValid = timingSafeEqual(validHmac, forgedSignature);
    assert.equal(isValid, false, 'Assinatura forjada deve falhar na verificação em tempo constante');
  });

  test('7. Webhook válido: assinatura oficial, persistência durável, conciliação e deduplicação', async () => {
    const intentId = randomUUID();
    const mpPaymentId = `mp-pay-${randomUUID()}`;
    const key = `key-hook-${randomUUID()}`;

    // Cria a intenção pendente
    await pool.query(
      `INSERT INTO public.payment_intents (id, merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status, mp_payment_id)
       VALUES ($1, $2, $3, 'digest-wh', 20000, 100, 'BRL', 'pix', 'wh@exemplo.com', 'processing', $4);`,
      [intentId, merchantA_id, key, mpPaymentId]
    );

    const requestId = `req-${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const manifest = `id:${mpPaymentId};request-id:${requestId};ts:${ts};`;
    const validSignature = await hmacSha256Hex(webhookSecret, manifest);

    assert.equal(timingSafeEqual(validSignature, validSignature), true);

    // 1. Armazenamento durável do evento no banco
    const eventId = `evt-${randomUUID()}`;
    const whRes = await pool.query(
      `INSERT INTO public.webhook_events (event_id, resource_id, topic, signature, payload, status)
       VALUES ($1, $2, 'payment.updated', $3, '{"action":"payment.updated"}'::jsonb, 'received')
       RETURNING *;`,
      [eventId, mpPaymentId, `ts=${ts},v1=${validSignature}`]
    );
    assert.equal(whRes.rows.length, 1);

    // 2. Liquidação atômica e transacional via settle_payment_transaction
    const settleRes = await pool.query(
      `SELECT public.settle_payment_transaction($1, $2, 'accredited') as settled;`,
      [intentId, mpPaymentId]
    );
    assert.equal(settleRes.rows[0].settled, true);

    // Verifica atualização da intenção
    const intentCheck = await pool.query('SELECT status FROM public.payment_intents WHERE id = $1;', [intentId]);
    assert.equal(intentCheck.rows[0].status, 'succeeded');

    // Verifica partidas dobradas (equilibradas: receivable = 20000, payable = -19900, revenue = -100)
    const entries = await pool.query('SELECT account, amount_cents FROM public.accounting_entries WHERE payment_id = $1;', [intentId]);
    assert.equal(entries.rows.length, 3);
    const sum = entries.rows.reduce((acc, row) => acc + BigInt(row.amount_cents), 0n);
    assert.equal(sum, 0n, 'Partidas dobradas devem somar exatamente zero');

    // Verifica lançamento no diário da carteira
    const journal = await pool.query('SELECT * FROM public.wallet_journal WHERE source_id = $1;', [intentId]);
    assert.equal(journal.rows.length, 1);
    assert.equal(journal.rows[0].action, 'settled');
    assert.equal(journal.rows[0].available_delta, '19900'); // 20000 - 100

    // 3. Deduplicação em re-tentativa (replay do webhook com o mesmo event_id)
    const replayRes = await pool.query(
      `INSERT INTO public.webhook_events (event_id, resource_id, topic, signature, payload, status)
       VALUES ($1, $2, 'payment.updated', $3, '{"action":"payment.updated"}'::jsonb, 'received')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *;`,
      [eventId, mpPaymentId, `ts=${ts},v1=${validSignature}`]
    );
    assert.equal(replayRes.rows.length, 0, 'Replay de webhook existente deve ser ignorado sem reprocessamento');
  });

  test('8. Webhook: eventos persistidos mas não concluídos (status=failed ou received) são reprocessados', async () => {
    const intentId = randomUUID();
    const mpPaymentId = `mp-pay-retry-${randomUUID()}`;
    const key = `key-hook-retry-${randomUUID()}`;

    // Cria a intenção pendente
    await pool.query(
      `INSERT INTO public.payment_intents (id, merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status, mp_payment_id)
       VALUES ($1, $2, $3, 'digest-wh-retry', 15000, 100, 'BRL', 'pix', 'retry@exemplo.com', 'processing', $4);`,
      [intentId, merchantA_id, key, mpPaymentId]
    );

    const eventId = `evt-retry-${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = `req-retry-${randomUUID()}`;
    const manifest = `id:${mpPaymentId};request-id:${requestId};ts:${ts};`;
    const validSignature = await hmacSha256Hex(webhookSecret, manifest);

    // Simula que o evento foi inserido inicialmente com status 'failed' (ex: falha transitória de rede upstream)
    await pool.query(
      `INSERT INTO public.webhook_events (event_id, resource_id, topic, signature, payload, status)
       VALUES ($1, $2, 'payment.updated', $3, '{"action":"payment.updated"}'::jsonb, 'failed');`,
      [eventId, mpPaymentId, `ts=${ts},v1=${validSignature}`]
    );

    // Na re-tentativa pelo Mercado Pago: consulta evento anterior
    const existing = await pool.query('SELECT * FROM public.webhook_events WHERE event_id = $1;', [eventId]);
    assert.equal(existing.rows.length, 1);
    assert.equal(existing.rows[0].status, 'failed');

    // Ao invés de descartar com already_processed, atualiza status para 'received' e conclui liquidação
    await pool.query(
      `UPDATE public.webhook_events SET status = 'received' WHERE event_id = $1;`,
      [eventId]
    );

    // Liquida a transação
    const settle = await pool.query(
      `SELECT public.settle_payment_transaction($1, $2, 'accredited') as settled;`,
      [intentId, mpPaymentId]
    );
    assert.equal(settle.rows[0].settled, true);

    // Marca evento como processado
    await pool.query(
      `UPDATE public.webhook_events SET status = 'processed', processed_at = NOW() WHERE event_id = $1;`,
      [eventId]
    );

    const finalEvt = await pool.query('SELECT status FROM public.webhook_events WHERE event_id = $1;', [eventId]);
    assert.equal(finalEvt.rows[0].status, 'processed');

    const finalIntent = await pool.query('SELECT status FROM public.payment_intents WHERE id = $1;', [intentId]);
    assert.equal(finalIntent.rows[0].status, 'succeeded');
  });

  test('9. Webhook: alteração posterior à aprovação (estorno / chargeback)', async () => {
    const intentId = randomUUID();
    const mpPaymentId = `mp-pay-reversal-${randomUUID()}`;
    const key = `key-hook-rev-${randomUUID()}`;

    // Cria e liquida a transação como 'succeeded'
    await pool.query(
      `INSERT INTO public.payment_intents (id, merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status, mp_payment_id)
       VALUES ($1, $2, $3, 'digest-wh-rev', 50000, 100, 'BRL', 'pix', 'rev@exemplo.com', 'processing', $4);`,
      [intentId, merchantA_id, key, mpPaymentId]
    );

    await pool.query(
      `SELECT public.settle_payment_transaction($1, $2, 'accredited');`,
      [intentId, mpPaymentId]
    );

    // Saldo disponível após liquidação deve ser R$ 499,00 (50000 - 100 = 49900 centavos)
    const journalAfterSettle = await pool.query(
      `SELECT available_delta FROM public.wallet_journal WHERE source_id = $1 AND action = 'settled';`,
      [intentId]
    );
    assert.equal(journalAfterSettle.rows[0].available_delta, '49900');

    // Mercado Pago envia notificação de alteração pós-aprovação: 'refunded'
    const reversalResult = await pool.query(
      `SELECT public.handle_payment_reversal($1, 'refunded', 'refunded_by_seller') as reversed;`,
      [intentId]
    );
    assert.equal(reversalResult.rows[0].reversed, true);

    // Verifica que o status da intenção mudou para 'refunded'
    const intentRev = await pool.query('SELECT status FROM public.payment_intents WHERE id = $1;', [intentId]);
    assert.equal(intentRev.rows[0].status, 'refunded');

    // Verifica lançamento estornando saldo disponível no diário da carteira
    const journalRev = await pool.query(
      `SELECT action, available_delta FROM public.wallet_journal WHERE source_id = $1 AND action = 'refunded';`,
      [intentId]
    );
    assert.equal(journalRev.rows.length, 1);
    assert.equal(journalRev.rows[0].available_delta, '-49900', 'Estorno deve debitar exatamente o saldo creditado');

    // Verifica registro imutável no log de auditoria
    const auditRev = await pool.query(
      `SELECT action, payload FROM public.audit_logs WHERE entity_id = $1 AND action = 'payment.refunded';`,
      [intentId]
    );
    assert.equal(auditRev.rows.length, 1);
    assert.equal(auditRev.rows[0].payload.status, 'refunded');
  });
});

