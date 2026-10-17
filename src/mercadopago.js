import { AppError, requireThat } from './errors.js';

const API = 'https://api.mercadopago.com';
const MAX_RESPONSE = 262144;
const statuses = new Set(['pending', 'approved', 'authorized', 'in_process', 'in_mediation', 'rejected', 'cancelled', 'refunded', 'charged_back']);

function providerId(value) {
  requireThat((typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) ||
    (Number.isSafeInteger(value) && value > 0), 502, 'mp_invalid_identifier');
  return String(value);
}

// Conversion is decimal parsing, never floating-point monetary arithmetic.
export function mercadoPagoCents(value) {
  requireThat(typeof value === 'string' || typeof value === 'number', 502, 'mp_invalid_amount');
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(String(value));
  requireThat(match, 502, 'mp_invalid_amount');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  requireThat(cents <= BigInt(Number.MAX_SAFE_INTEGER), 502, 'mp_invalid_amount');
  return Number(cents);
}

async function boundedJson(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(502, 'mp_invalid_response');
  }
  requireThat(response.body, 502, 'mp_invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireThat(size <= MAX_RESPONSE, 502, 'mp_response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new AppError(502, 'mp_invalid_response'); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Fixed provider origin and bounded transport shared by read-only and OAuth adapters.
export async function mercadoPagoRequest({ path, method = 'GET', headers = {}, body, fetchImpl = fetch, timeoutMs = 5000 }) {
  requireThat(path === '/oauth/token' || path === '/v1/payments' || /^\/v1\/payments\/[1-9]\d{0,19}$/.test(path), 500, 'mp_invalid_endpoint');
  requireThat((['/oauth/token', '/v1/payments'].includes(path) && method === 'POST') || (/^\/v1\/payments\//.test(path) && method === 'GET'), 500, 'mp_invalid_endpoint');
  requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 15000, 500, 'mp_invalid_timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API}${path}`, { method, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'mp_access_denied' :
        response.status === 404 ? 'mp_payment_not_found' : response.status === 429 ? 'mp_rate_limited' : 'mp_unavailable';
      throw new AppError(502, code);
    }
    return await boundedJson(response);
  } catch (error) {
    if (controller.signal.aborted) throw new AppError(504, 'mp_timeout');
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'mp_unavailable');
  } finally { clearTimeout(timer); }
}

export function verifiedTestPayment(body, expected, id = body?.id) {
  const paymentId = providerId(id); const collectorId = providerId(expected.collectorId);
  requireThat(body && typeof body === 'object' && !Array.isArray(body), 502, 'mp_invalid_response');
  requireThat(body.live_mode === false, 502, 'mp_non_test_payment');
  requireThat(providerId(body.id) === paymentId && providerId(body.collector_id) === collectorId &&
    body.external_reference === expected.externalReference && body.currency_id === 'BRL' &&
    mercadoPagoCents(body.transaction_amount) === expected.amountCents, 409, 'mp_payment_mismatch');
  const method = body.payment_method_id === 'pix' ? 'pix' :
    ['credit_card', 'debit_card'].includes(body.payment_type_id) ? 'card' : null;
  requireThat(method === expected.method, 409, 'mp_payment_mismatch');
  requireThat(statuses.has(body.status), 502, 'mp_unknown_status');
  const refundedCents = mercadoPagoCents(body.transaction_amount_refunded);
  requireThat(refundedCents <= expected.amountCents, 502, 'mp_invalid_amount');
  return { id: paymentId, collectorId, externalReference: expected.externalReference,
    amountCents: expected.amountCents, refundedCents, currency: 'BRL', method,
    providerStatus: body.status, environment: 'test' };
}

// Read-only preparation: deliberately not plugged into Payments or the wallet.
// The caller must load expected values from its own trusted database, never a webhook body.
export class MercadoPagoTestReader {
  #token;
  #fetch;
  #timeoutMs;
  constructor({ accessToken, fetchImpl = fetch, timeoutMs = 5000 }) {
    requireThat(typeof accessToken === 'string' && /^TEST-[A-Za-z0-9_-]{10,}$/.test(accessToken), 500, 'mp_test_credentials_required');
    requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 15000, 500, 'mp_invalid_timeout');
    this.#token = accessToken; this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }
  async getPayment(id, expected) {
    const paymentId = providerId(id);
    requireThat(expected && typeof expected.externalReference === 'string' && expected.externalReference.length > 0 &&
      Number.isSafeInteger(expected.amountCents) && expected.amountCents > 0 &&
      ['pix', 'card'].includes(expected.method), 500, 'mp_expected_payment_required');
    providerId(expected.collectorId);
      const body = await mercadoPagoRequest({ path: `/v1/payments/${paymentId}`,
        headers: { Authorization: `Bearer ${this.#token}` }, fetchImpl: this.#fetch, timeoutMs: this.#timeoutMs });
      return verifiedTestPayment(body, expected, paymentId);
  }
}
