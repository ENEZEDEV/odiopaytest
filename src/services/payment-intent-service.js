import { createHash } from 'node:crypto';
import { calculateServerFee } from '../finance/tariffs.js';

function computeDigest(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Sanitizes the output DTO to guarantee zero leakage of internal tokens,
 * collector secrets, or database implementation details.
 */
export function sanitizePaymentResponse(intent, mpPaymentData = null) {
  return {
    payment: {
      id: intent.id,
      merchantId: intent.merchantId,
      idempotencyKey: intent.idempotencyKey,
      amountCents: intent.amountCents,
      feeCents: intent.feeCents,
      netCents: intent.amountCents - intent.feeCents,
      currency: 'BRL',
      method: intent.method,
      status: intent.status,
      statusDetail: intent.statusDetail || (mpPaymentData?.status_detail ?? null),
      mpPaymentId: intent.mpPaymentId || (mpPaymentData?.id ? String(mpPaymentData.id) : null),
      qrCode: intent.qrCode || (mpPaymentData?.point_of_interaction?.transaction_data?.qr_code ?? null),
      qrCodeBase64: intent.qrCodeBase64 || (mpPaymentData?.point_of_interaction?.transaction_data?.qr_code_base64 ?? null),
      ticketUrl: intent.ticketUrl || (mpPaymentData?.point_of_interaction?.transaction_data?.ticket_url ?? null),
      createdAt: intent.createdAt,
      replayed: Boolean(intent.replayed),
      environment: 'sandbox'
    }
  };
}

export class PaymentIntentService {
  #db;
  #vault;
  #fetchImpl;
  #mpBaseUrl;
  #inFlight = new Map();

  constructor({ db, vault, fetchImpl = fetch, mpBaseUrl = 'https://api.mercadopago.com' }) {
    this.#db = db;
    this.#vault = vault;
    this.#fetchImpl = fetchImpl;
    this.#mpBaseUrl = mpBaseUrl;
  }

  /**
   * Main entrypoint: process payment with authenticated context
   */
  async createPaymentIntent({ authUserId, idempotencyKey, input }) {
    if (!authUserId) {
      throw { status: 401, code: 'unauthorized', message: 'Authentication required' };
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw { status: 400, code: 'invalid_idempotency_key', message: 'Valid idempotency-key header required (8-128 chars)' };
    }

    // 1. Derive merchant strictly from auth identity
    const merchant = await this.#db.getMerchantByAuthId(authUserId);
    if (!merchant) {
      throw { status: 403, code: 'merchant_not_found', message: 'No registered merchant associated with authenticated user' };
    }

    // Concurrent request deduplication
    const lockKey = `${merchant.id}:${idempotencyKey}`;
    if (this.#inFlight.has(lockKey)) {
      const result = await this.#inFlight.get(lockKey);
      return {
        payment: {
          ...result.payment,
          replayed: true
        }
      };
    }

    const executionPromise = this.#executePaymentIntent(merchant, idempotencyKey, input);
    this.#inFlight.set(lockKey, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.#inFlight.delete(lockKey);
    }
  }

  async #executePaymentIntent(merchant, idempotencyKey, input) {
    // 2. Validate input parameters strictly
    const { amountCents, method, payerEmail, cardToken, paymentMethodId } = input;

    if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100000000) {
      throw { status: 400, code: 'invalid_amount', message: 'Amount must be an integer between 100 and 100000000 cents' };
    }
    if (!['pix', 'card'].includes(method)) {
      throw { status: 400, code: 'invalid_method', message: "Payment method must be 'pix' or 'card'" };
    }
    if (typeof payerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail) || payerEmail.length > 254) {
      throw { status: 400, code: 'invalid_payer_email', message: 'Valid payer email required' };
    }

    if (method === 'card') {
      if (typeof cardToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(cardToken)) {
        throw { status: 400, code: 'invalid_card_token', message: 'Invalid card token format' };
      }
      if (typeof paymentMethodId !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(paymentMethodId)) {
        throw { status: 400, code: 'invalid_payment_method_id', message: 'Invalid card paymentMethodId' };
      }
    }

    // 3. Calculate commission strictly on server side according to merchant's plan
    // Client-supplied fee values are completely disregarded/overridden
    const feeCents = calculateServerFee(amountCents, method, merchant.plan);

    // 4. Request fingerprint for idempotency check
    const normalizedInput = {
      merchantId: merchant.id,
      amountCents,
      feeCents,
      method,
      payerEmail,
      cardToken: method === 'card' ? cardToken : null,
      paymentMethodId: method === 'card' ? paymentMethodId : null
    };
    const requestDigest = computeDigest(normalizedInput);

    // 5. Check persistent payment intent (idempotency per merchant)
    const existingIntent = await this.#db.getPaymentIntent(merchant.id, idempotencyKey);
    if (existingIntent) {
      if (existingIntent.requestDigest !== requestDigest) {
        throw {
          status: 409,
          code: 'idempotency_conflict',
          message: 'The idempotency key was already used with different request parameters'
        };
      }
      return sanitizePaymentResponse({ ...existingIntent, replayed: true });
    }

    // 6. Retrieve and decrypt seller OAuth credentials
    const oauthConnection = await this.#db.getOAuthConnection(merchant.id);
    if (!oauthConnection || oauthConnection.status !== 'active') {
      throw {
        status: 403,
        code: 'oauth_connection_required',
        message: 'Active Mercado Pago OAuth connection is required for this merchant'
      };
    }

    let sellerAccessToken;
    try {
      const context = `mp:oauth:${merchant.id}:${oauthConnection.sellerId}`;
      const decryptedTokens = this.#vault.open(oauthConnection.encryptedAccessToken, context);
      sellerAccessToken = typeof decryptedTokens === 'string' ? decryptedTokens : decryptedTokens.accessToken;
    } catch (err) {
      throw {
        status: 500,
        code: 'credentials_decryption_error',
        message: 'Failed to securely decrypt seller OAuth credentials'
      };
    }

    // 7. Enforce sandbox/homologation environment: reject production tokens
    if (!sellerAccessToken || !sellerAccessToken.startsWith('TEST-')) {
      throw {
        status: 500,
        code: 'mp_test_credentials_required',
        message: 'Only sandbox/test credentials starting with TEST- are permitted'
      };
    }

    // 8. Create persistent intent in database with status 'processing'
    let intentId;
    try {
      intentId = await this.#db.createPaymentIntent({
        merchantId: merchant.id,
        idempotencyKey,
        requestDigest,
        amountCents,
        feeCents,
        currency: 'BRL',
        method,
        payerEmail,
        status: 'processing'
      });
    } catch (dbErr) {
      if (dbErr.message && dbErr.message.includes('unique_violation')) {
        const recheck = await this.#db.getPaymentIntent(merchant.id, idempotencyKey);
        if (recheck) {
          return sanitizePaymentResponse({ ...recheck, replayed: true });
        }
      }
      throw dbErr;
    }

    // 9. Format exact decimals for Mercado Pago
    const decimalAmount = Number((amountCents / 100).toFixed(2));
    const decimalFee = Number((feeCents / 100).toFixed(2));

    const mpPayload = {
      transaction_amount: decimalAmount,
      application_fee: decimalFee,
      external_reference: intentId,
      description: `ODIOPAY homologação intent ${intentId}`,
      payer: { email: payerEmail },
      payment_method_id: method === 'pix' ? 'pix' : paymentMethodId,
      ...(method === 'card' ? { token: cardToken, installments: 1 } : {})
    };

    let mpResponse;
    let mpData;

    try {
      mpResponse = await this.#fetchImpl(`${this.#mpBaseUrl}/v1/payments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sellerAccessToken}`,
          'X-Idempotency-Key': `${merchant.id}:${idempotencyKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mpPayload)
      });

      mpData = await mpResponse.json();
    } catch (networkError) {
      // 10. RECONCILIATION ON NETWORK ERROR / TIMEOUT
      const reconciled = await this.reconcileUncertainPayment(sellerAccessToken, intentId);
      if (reconciled) {
        return sanitizePaymentResponse(reconciled);
      }

      await this.#db.updatePaymentIntentStatus(intentId, 'requires_reconciliation', {
        errorCode: 'network_timeout_or_reset'
      });

      throw {
        status: 504,
        code: 'gateway_timeout',
        message: 'Payment gateway communication timed out; intent marked for automatic reconciliation'
      };
    }

    if (mpResponse.status >= 500) {
      const reconciled = await this.reconcileUncertainPayment(sellerAccessToken, intentId);
      if (reconciled) {
        return sanitizePaymentResponse(reconciled);
      }

      await this.#db.updatePaymentIntentStatus(intentId, 'requires_reconciliation', {
        errorCode: `mp_error_${mpResponse.status}`
      });

      throw {
        status: 502,
        code: 'gateway_error',
        message: 'Payment gateway responded with upstream error; intent preserved for reconciliation'
      };
    }

    // Verify response integrity
    if (mpData.live_mode !== false) {
      await this.#db.updatePaymentIntentStatus(intentId, 'failed', { errorCode: 'production_mode_prohibited' });
      throw { status: 502, code: 'mp_production_blocked', message: 'Production response rejected in homologation' };
    }

    if (String(mpData.collector_id) !== String(oauthConnection.sellerId)) {
      await this.#db.updatePaymentIntentStatus(intentId, 'failed', { errorCode: 'seller_mismatch' });
      throw { status: 409, code: 'mp_seller_mismatch', message: 'Receiver account does not match registered seller' };
    }

    // Map status
    const isApproved = mpData.status === 'approved';
    const finalStatus = isApproved ? 'succeeded' : (mpData.status === 'rejected' ? 'failed' : 'requires_action');

    const updatedIntent = await this.#db.updatePaymentIntentStatus(intentId, finalStatus, {
      mpPaymentId: String(mpData.id),
      mpStatus: mpData.status,
      mpStatusDetail: mpData.status_detail,
      qrCode: mpData.point_of_interaction?.transaction_data?.qr_code,
      qrCodeBase64: mpData.point_of_interaction?.transaction_data?.qr_code_base64,
      ticketUrl: mpData.point_of_interaction?.transaction_data?.ticket_url
    });

    if (isApproved) {
      await this.#db.recordSettledAccounting({
        paymentId: intentId,
        merchantId: merchant.id,
        amountCents,
        feeCents,
        netCents: amountCents - feeCents
      });
    }

    return sanitizePaymentResponse(updatedIntent, mpData);
  }

  /**
   * Reconciles uncertain payment by querying Mercado Pago by external_reference
   */
  async reconcileUncertainPayment(sellerAccessToken, intentId) {
    try {
      const searchUrl = `${this.#mpBaseUrl}/v1/payments/search?external_reference=${encodeURIComponent(intentId)}`;
      const res = await this.#fetchImpl(searchUrl, {
        headers: { 'Authorization': `Bearer ${sellerAccessToken}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        const found = data.results[0];
        const isApproved = found.status === 'approved';
        const finalStatus = isApproved ? 'succeeded' : (found.status === 'rejected' ? 'failed' : 'requires_action');

        const updatedIntent = await this.#db.updatePaymentIntentStatus(intentId, finalStatus, {
          mpPaymentId: String(found.id),
          mpStatus: found.status,
          mpStatusDetail: found.status_detail,
          qrCode: found.point_of_interaction?.transaction_data?.qr_code,
          qrCodeBase64: found.point_of_interaction?.transaction_data?.qr_code_base64,
          ticketUrl: found.point_of_interaction?.transaction_data?.ticket_url
        });
        return updatedIntent;
      }
    } catch {
      // Reconciliation query failed; return null so caller handles accordingly
    }
    return null;
  }
}
