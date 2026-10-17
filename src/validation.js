import { requireThat } from './errors.js';

export const MAX_AMOUNT = 100_000_000;
export const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function exactObject(value, allowed, required = allowed) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_object');
  requireThat(Object.keys(value).every(key => allowed.includes(key)), 400, 'unexpected_field');
  requireThat(required.every(key => Object.hasOwn(value, key)), 400, 'missing_field');
}

export function paymentInput(input) {
  exactObject(input, ['amountCents', 'currency', 'method', 'cardToken'], ['amountCents', 'currency', 'method']);
  requireThat(Number.isSafeInteger(input.amountCents) && input.amountCents >= 100 && input.amountCents <= MAX_AMOUNT, 400, 'invalid_amount');
  requireThat(input.currency === 'BRL', 400, 'invalid_currency');
  requireThat(['pix', 'card'].includes(input.method), 400, 'invalid_method');
  if (input.method === 'card') {
    requireThat(typeof input.cardToken === 'string' && /^tok_sandbox_[A-Za-z0-9_-]{16,100}$/.test(input.cardToken), 400, 'invalid_card_token');
  } else {
    requireThat(!Object.hasOwn(input, 'cardToken'), 400, 'unexpected_card_token');
  }
  return { amountCents: input.amountCents, currency: input.currency, method: input.method, ...(input.method === 'card' ? { cardToken: input.cardToken } : {}) };
}

export function idempotencyKey(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value), 400, 'invalid_idempotency_key');
  return value;
}

export function eventInput(input) {
  exactObject(input, ['id', 'paymentId', 'providerId', 'merchantId', 'amountCents', 'currency', 'method', 'status']);
  requireThat(['id', 'paymentId', 'providerId', 'merchantId'].every(key => isId(input[key])), 400, 'invalid_event_id');
  requireThat(['succeeded', 'failed'].includes(input.status), 400, 'invalid_event_status');
  requireThat(Number.isSafeInteger(input.amountCents) && input.amountCents >= 100 && input.amountCents <= MAX_AMOUNT, 400, 'invalid_amount');
  requireThat(input.currency === 'BRL' && ['pix', 'card'].includes(input.method), 400, 'invalid_event_payment');
  return Object.fromEntries(['id', 'paymentId', 'providerId', 'merchantId', 'amountCents', 'currency', 'method', 'status'].map(key => [key, input[key]]));
}
