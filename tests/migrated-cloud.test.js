import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TokenVault } from '../src/security/token-vault.js';
import { calculateServerFee, TARIFFS } from '../src/finance/tariffs.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';

// In-Memory Database Simulator for testing RLS and Supabase Cloud behavior
class MockCloudDatabase {
  constructor() {
    this.merchants = new Map();
    this.oauthConnections = new Map();
    this.paymentIntents = new Map();
    this.payments = new Map();
    this.accountingEntries = [];
  }

  async getMerchantByAuthId(authUserId) {
    for (const merchant of this.merchants.values()) {
      if (merchant.authUserId === authUserId) return { ...merchant };
    }
    return null;
  }

  async getOAuthConnection(merchantId) {
    const conn = this.oauthConnections.get(merchantId);
    return conn ? { ...conn } : null;
  }

  async getPaymentIntent(merchantId, idempotencyKey) {
    const key = `${merchantId}:${idempotencyKey}`;
    const intent = this.paymentIntents.get(key);
    return intent ? { ...intent } : null;
  }

  async createPaymentIntent(data) {
    const id = randomUUID();
    const key = `${data.merchantId}:${data.idempotencyKey}`;
    if (this.paymentIntents.has(key)) {
      throw new Error('unique_violation: uq_payment_intents_merchant_idempotency');
    }
    const record = {
      id,
      ...data,
      createdAt: new Date().toISOString()
    };
    this.paymentIntents.set(key, record);
    this.paymentIntents.set(id, record); // lookup by id as well
    return id;
  }

  async updatePaymentIntentStatus(intentId, status, fields = {}) {
    const record = this.paymentIntents.get(intentId);
    if (!record) throw new Error('intent_not_found');
    record.status = status;
    if (fields.mpPaymentId) record.mpPaymentId = fields.mpPaymentId;
    if (fields.mpStatus) record.mpStatus = fields.mpStatus;
    if (fields.mpStatusDetail) record.mpStatusDetail = fields.mpStatusDetail;
    if (fields.qrCode) record.qrCode = fields.qrCode;
    if (fields.qrCodeBase64) record.qrCodeBase64 = fields.qrCodeBase64;
    if (fields.ticketUrl) record.ticketUrl = fields.ticketUrl;
    if (fields.errorCode) record.errorCode = fields.errorCode;
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  async recordSettledAccounting(entry) {
    this.accountingEntries.push({ ...entry, recordedAt: new Date().toISOString() });
  }
}

// Test Fixture Setup
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x42);
const vault = new TokenVault(TEST_ENCRYPTION_KEY);

function setupEnvironment() {
  const db = new MockCloudDatabase();

  // Merchant 1 (Standard Plan)
  const m1AuthId = randomUUID();
  const m1Id = randomUUID();
  const m1SellerId = '111222333';
  db.merchants.set(m1Id, {
    id: m1Id,
    authUserId: m1AuthId,
    name: 'Loja Alpha',
    plan: 'standard'
  });
  const m1TokenContext = `mp:oauth:${m1Id}:${m1SellerId}`;
  db.oauthConnections.set(m1Id, {
    merchantId: m1Id,
    sellerId: m1SellerId,
    encryptedAccessToken: vault.seal({ accessToken: 'TEST-ACCESS-TOKEN-M1' }, m1TokenContext),
    publicKey: 'TEST-PUBLIC-KEY-M1',
    status: 'active'
  });

  // Merchant 2 (Pro Plan)
  const m2AuthId = randomUUID();
  const m2Id = randomUUID();
  const m2SellerId = '444555666';
  db.merchants.set(m2Id, {
    id: m2Id,
    authUserId: m2AuthId,
    name: 'Loja Beta',
    plan: 'pro'
  });
  const m2TokenContext = `mp:oauth:${m2Id}:${m2SellerId}`;
  db.oauthConnections.set(m2Id, {
    merchantId: m2Id,
    sellerId: m2SellerId,
    encryptedAccessToken: vault.seal({ accessToken: 'TEST-ACCESS-TOKEN-M2' }, m2TokenContext),
    publicKey: 'TEST-PUBLIC-KEY-M2',
    status: 'active'
  });

  return { db, m1: { id: m1Id, authId: m1AuthId, sellerId: m1SellerId }, m2: { id: m2Id, authId: m2AuthId, sellerId: m2SellerId } };
}

// ==============================================================================
// TEST SUITE: Versão Migrada Cloud (Segurança, Isolamento e Resiliência)
// ==============================================================================

test('1. Acesso entre lojistas (Cross-merchant isolation): Nega acesso a lojista não autorizado', async () => {
  const { db, m1, m2 } = setupEnvironment();
  const service = new PaymentIntentService({ db, vault });

  // Tentativa com token de autenticação inexistente ou forjado
  await assert.rejects(
    async () => {
      await service.createPaymentIntent({
        authUserId: randomUUID(), // ID que não pertence a nenhum lojista registrado
        idempotencyKey: 'idem-cross-1',
        input: { amountCents: 5000, method: 'pix', payerEmail: 'test@cliente.com' }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'merchant_not_found');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // Tentativa sem autenticação (token nulo/vazio)
  await assert.rejects(
    async () => {
      await service.createPaymentIntent({
        authUserId: null,
        idempotencyKey: 'idem-cross-2',
        input: { amountCents: 5000, method: 'pix', payerEmail: 'test@cliente.com' }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'unauthorized');
      assert.strictEqual(err.status, 401);
      return true;
    }
  );
});

test('2. Comissão adulterada (Tampered commission): Rejeita/ignora comissão vinda do cliente e recalcula estritamente no servidor', async () => {
  const { db, m1, m2 } = setupEnvironment();

  let capturedMpPayload = null;
  const mockFetch = async (url, opts) => {
    if (url.includes('/v1/payments')) {
      capturedMpPayload = JSON.parse(opts.body);
      const isM1 = opts.headers.Authorization.includes('M1');
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 99887766,
          status: 'approved',
          status_detail: 'accredited',
          collector_id: isM1 ? m1.sellerId : m2.sellerId,
          live_mode: false,
          point_of_interaction: {
            transaction_data: { qr_code: 'pix-qr-code-test', ticket_url: 'https://test.ticket' }
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const service = new PaymentIntentService({ db, vault, fetchImpl: mockFetch });

  // Cliente envia maliciosamente application_fee = 0 ou feeCents = 1 centavo para pagamento de R$ 100,00 (10000 centavos)
  const result = await service.createPaymentIntent({
    authUserId: m1.authId, // Loja Alpha: Standard Plan (PIX = 0 bps + R$ 1,00 = 100 centavos)
    idempotencyKey: 'idem-fee-tamper-1',
    input: {
      amountCents: 10000,
      feeCents: 1, // TENTATIVA DE FRAUDE: o cliente quer pagar apenas 1 centavo de comissão!
      application_fee: 0.01,
      method: 'pix',
      payerEmail: 'cliente@exemplo.com'
    }
  });

  // O servidor DEVE ignorar o valor enviado pelo cliente e calcular a taxa legítima: 100 centavos
  assert.strictEqual(result.payment.feeCents, 100, 'Taxa calculada no servidor deve ser exatamente 100 centavos');
  assert.strictEqual(result.payment.netCents, 9900, 'Valor líquido deve ser 9900 centavos');
  assert.strictEqual(capturedMpPayload.application_fee, 1.00, 'Payload enviado ao Mercado Pago deve ter application_fee calculado pelo servidor (1.00)');

  // Teste com Cartão de Crédito no Plano Pro (Loja Beta)
  // R$ 200,00 (20000 centavos) -> Pro Card: 2.99% (598 centavos) + 30 centavos fixos = 628 centavos
  const resultCard = await service.createPaymentIntent({
    authUserId: m2.authId,
    idempotencyKey: 'idem-fee-tamper-2',
    input: {
      amountCents: 20000,
      feeCents: 0, // TENTATIVA DE FRAUDE: cliente tenta zerar a comissão
      method: 'card',
      cardToken: 'tok_test_card_12345678',
      paymentMethodId: 'visa',
      payerEmail: 'cliente2@exemplo.com'
    }
  });

  assert.strictEqual(resultCard.payment.feeCents, 628, 'Taxa do cartão Pro deve ser exatamente 628 centavos');
  assert.strictEqual(capturedMpPayload.application_fee, 6.28, 'application_fee do cartão enviado ao MP deve ser 6.28');
});

test('3. Duplicação concorrente (Concurrent duplicate requests): 10 chamadas simultâneas com mesma idempotency_key resultam em 1 cobrança e respostas consistentes', async () => {
  const { db, m1 } = setupEnvironment();

  let mpCallsCount = 0;
  const mockFetch = async (url, opts) => {
    if (url.includes('/v1/payments')) {
      mpCallsCount++;
      // Simula latência de I/O
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 55443322,
          status: 'pending',
          status_detail: 'pending_waiting_transfer',
          collector_id: m1.sellerId,
          live_mode: false,
          point_of_interaction: { transaction_data: { qr_code: 'pix-code' } }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const service = new PaymentIntentService({ db, vault, fetchImpl: mockFetch });
  const idempotencyKey = 'idem-concurrency-key-8899';

  // Dispara 10 requisições rigorosamente simultâneas
  const promises = Array.from({ length: 10 }).map(() =>
    service.createPaymentIntent({
      authUserId: m1.authId,
      idempotencyKey,
      input: {
        amountCents: 7500,
        method: 'pix',
        payerEmail: 'comprador@teste.com'
      }
    })
  );

  const results = await Promise.all(promises);

  // Exatamente 1 chamada externa ao Mercado Pago deve ter sido feita
  assert.strictEqual(mpCallsCount, 1, 'Mercado Pago deve ser chamado apenas 1 vez');

  // Todas as 10 respostas retornadas devem ter os mesmos valores e o mesmo ID de pagamento
  const firstPaymentId = results[0].payment.id;
  for (const res of results) {
    assert.strictEqual(res.payment.id, firstPaymentId);
    assert.strictEqual(res.payment.amountCents, 7500);
    assert.strictEqual(res.payment.currency, 'BRL');
  }

  // Pelo menos 9 devem estar marcadas como replayed: true
  const replayedCount = results.filter((r) => r.payment.replayed).length;
  assert.strictEqual(replayedCount, 9, 'As 9 requisições concorrentes adicionais devem ser identificadas como replayed');
});

test('4. Falhas de rede e reconciliação de respostas incertas: Timeout/504 recupera estado sem duplicar cobrança', async () => {
  const { db, m1 } = setupEnvironment();

  let postAttempted = false;
  let searchAttempted = false;

  const mockFetch = async (url, opts) => {
    // 1. A chamada POST primária falha por queda de rede / timeout
    if (url.includes('/v1/payments') && opts.method === 'POST') {
      postAttempted = true;
      throw new Error('fetch failed: ECONNRESET / ETIMEDOUT');
    }

    // 2. A chamada de reconciliação busca pelo external_reference (ID do intent)
    if (url.includes('/v1/payments/search')) {
      searchAttempted = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: 77889900,
              status: 'approved',
              status_detail: 'accredited',
              collector_id: m1.sellerId,
              live_mode: false,
              point_of_interaction: { transaction_data: { qr_code: 'reconciled-qr' } }
            }
          ]
        })
      };
    }

    return { ok: false, status: 404 };
  };

  const service = new PaymentIntentService({ db, vault, fetchImpl: mockFetch });

  const result = await service.createPaymentIntent({
    authUserId: m1.authId,
    idempotencyKey: 'idem-uncertain-recovery-1',
    input: {
      amountCents: 12000,
      method: 'pix',
      payerEmail: 'recon@teste.com'
    }
  });

  assert.strictEqual(postAttempted, true, 'Tentativa inicial de POST ocorreu');
  assert.strictEqual(searchAttempted, true, 'Mecanismo de reconciliação consultou Mercado Pago por external_reference');
  assert.strictEqual(result.payment.status, 'succeeded', 'Status final foi reconciliado como succeeded');
  assert.strictEqual(result.payment.mpPaymentId, '77889900', 'ID upstream recuperado com sucesso');
});
