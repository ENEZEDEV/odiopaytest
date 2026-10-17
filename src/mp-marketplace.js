import { exactObject, isId, idempotencyKey, MAX_AMOUNT } from './validation.js';
import { requireThat } from './errors.js';
import { mercadoPagoRequest, verifiedTestPayment } from './mercadopago.js';

function decimal(cents) {
  // JSON numeric value serialized exactly, without floating-point division.
  const value = BigInt(cents);
  return JSON.rawJSON(`${value / 100n}.${String(value % 100n).padStart(2, '0')}`);
}

// Low-level test adapter. A durable intent/outbox must own these trusted fields before
// exposing this operation through HTTP. No retry, local credit or wallet settlement here.
export class MercadoPagoTestMarketplace {
  #connections; #fetch;
  constructor({ connections, fetchImpl = fetch }) { this.#connections = connections; this.#fetch = fetchImpl; }
  async create(merchantId, intent, checkout) {
    requireThat(isId(merchantId), 401, 'mp_identity_required');
    exactObject(intent, ['paymentId', 'idempotencyKey', 'amountCents', 'commissionCents', 'method']);
    requireThat(isId(intent.paymentId) && ['pix', 'card'].includes(intent.method), 400, 'mp_invalid_intent');
    idempotencyKey(intent.idempotencyKey);
    requireThat(Number.isSafeInteger(intent.amountCents) && intent.amountCents >= 100 && intent.amountCents <= MAX_AMOUNT &&
      Number.isSafeInteger(intent.commissionCents) && intent.commissionCents >= 0 && intent.commissionCents < intent.amountCents, 400, 'mp_invalid_commission');
    exactObject(checkout, ['payerEmail', 'cardToken', 'paymentMethodId'], ['payerEmail']);
    requireThat(typeof checkout.payerEmail === 'string' && checkout.payerEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(checkout.payerEmail), 400, 'mp_invalid_payer');
    if (intent.method === 'card') {
      requireThat(typeof checkout.cardToken === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(checkout.cardToken) && !/^\d{12,19}$/.test(checkout.cardToken) &&
        typeof checkout.paymentMethodId === 'string' && /^[a-z][a-z0-9_]{1,30}$/.test(checkout.paymentMethodId) &&
        !['pix', 'boleto', 'account_money'].includes(checkout.paymentMethodId), 400, 'mp_invalid_card_token');
    } else requireThat(!Object.hasOwn(checkout, 'cardToken') && !Object.hasOwn(checkout, 'paymentMethodId'), 400, 'mp_unexpected_card_data');
    return this.#connections.withConnection(merchantId, async ({ accessToken, sellerId }) => {
      requireThat(/^TEST-[A-Za-z0-9_-]{10,}$/.test(accessToken), 500, 'mp_test_credentials_required');
      const body = await mercadoPagoRequest({ path: '/v1/payments', method: 'POST', fetchImpl: this.#fetch,
        headers: { Authorization: `Bearer ${accessToken}`, 'X-Idempotency-Key': intent.idempotencyKey },
        body: { transaction_amount: decimal(intent.amountCents), application_fee: decimal(intent.commissionCents),
          external_reference: intent.paymentId, description: 'ODIOPAY test payment', payer: { email: checkout.payerEmail },
          payment_method_id: intent.method === 'pix' ? 'pix' : checkout.paymentMethodId,
          ...(intent.method === 'card' ? { token: checkout.cardToken, installments: 1 } : {}) } });
      return verifiedTestPayment(body, { collectorId: sellerId, externalReference: intent.paymentId,
        amountCents: intent.amountCents, method: intent.method });
    });
  }
}
