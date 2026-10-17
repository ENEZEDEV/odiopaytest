import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { requireThat } from './errors.js';
import { digest } from './security.js';
import { eventInput, idempotencyKey, isId, paymentInput } from './validation.js';

// Illustrative sandbox tariffs. They are not a commercial offer.
const TARIFFS = Object.freeze({
  standard: { pix: { bps: 0, fixed: 100 }, card: { bps: 399, fixed: 39 } },
  pro: { pix: { bps: 0, fixed: 50 }, card: { bps: 299, fixed: 30 } }
});

export function calculateFee(amount, method, plan) {
  const rule = TARIFFS[plan]?.[method];
  requireThat(rule, 400, 'invalid_tariff');
  const proportional = (BigInt(amount) * BigInt(rule.bps) + 9999n) / 10000n;
  return Math.min(amount, Number(proportional) + rule.fixed);
}

function publicPayment(row) {
  return { id: row.id, providerId: row.provider_id, amountCents: row.amount_cents, feeCents: row.fee_cents,
    netCents: row.amount_cents - row.fee_cents, currency: row.currency, method: row.method,
    status: row.status, createdAt: row.created_at, environment: 'sandbox' };
}

export class Payments {
  constructor(db, provider) { this.db = db; this.provider = provider; }
  audit(merchantId, paymentId, action) {
    this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(randomUUID(), merchantId, paymentId, action, new Date().toISOString());
  }
  create(merchant, input, key) {
    const normalized = paymentInput(input);
    idempotencyKey(key);
    const fingerprint = digest(JSON.stringify(normalized));
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM payments WHERE merchant_id=? AND idempotency_key=?').get(merchant.id, key);
      if (existing) {
        requireThat(existing.request_digest === fingerprint, 409, 'idempotency_conflict');
        return { payment: publicPayment(existing), replayed: true };
      }
      const id = randomUUID();
      const providerId = this.provider.create(merchant.id, normalized);
      const fee = calculateFee(normalized.amountCents, normalized.method, merchant.plan);
      this.db.prepare(`INSERT INTO payments (id,merchant_id,provider_id,amount_cents,fee_cents,currency,method,status,idempotency_key,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, merchant.id, providerId, normalized.amountCents, fee, 'BRL', normalized.method, 'pending', key, fingerprint, new Date().toISOString());
      this.audit(merchant.id, id, 'payment.created');
      return { payment: this.get(merchant.id, id), replayed: false };
    });
  }
  get(merchantId, id) {
    requireThat(isId(id), 404, 'not_found');
    const row = this.db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(id, merchantId);
    requireThat(row, 404, 'not_found');
    return publicPayment(row);
  }
  list(merchantId) {
    return this.db.prepare('SELECT * FROM payments WHERE merchant_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(merchantId).map(publicPayment);
  }
  confirm(input) {
    const event = eventInput(input);
    const fingerprint = digest(JSON.stringify(event));
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT digest FROM events WHERE id=?').get(event.id);
      if (previous) {
        requireThat(previous.digest === fingerprint, 409, 'event_conflict');
        return { accepted: true, replayed: true };
      }
      const row = this.db.prepare('SELECT * FROM payments WHERE id=?').get(event.paymentId);
      requireThat(row, 404, 'not_found');
      requireThat(row.provider_id === event.providerId && row.merchant_id === event.merchantId && row.amount_cents === event.amountCents && row.currency === event.currency && row.method === event.method, 409, 'payment_mismatch');
      const verified = this.provider.get(row.provider_id);
      requireThat(verified && verified.status === event.status && verified.amount_cents === row.amount_cents && verified.currency === row.currency && verified.method === row.method && verified.merchant_id === row.merchant_id, 409, 'provider_not_confirmed');
      requireThat(row.status === 'pending' || row.status === event.status, 409, 'invalid_transition');
      if (row.status === 'pending') {
        this.db.prepare('UPDATE payments SET status=? WHERE id=?').run(event.status, row.id);
        if (event.status === 'succeeded') {
          const insert = this.db.prepare('INSERT INTO accounting_entries VALUES (?,?,?)');
          insert.run(row.id, 'provider_receivable', row.amount_cents);
          insert.run(row.id, 'merchant_payable', -(row.amount_cents - row.fee_cents));
          insert.run(row.id, 'platform_revenue', -row.fee_cents);
        }
        this.audit(row.merchant_id, row.id, `payment.${event.status}`);
      }
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(event.id, fingerprint, row.id, new Date().toISOString());
      return { accepted: true, replayed: row.status !== 'pending' };
    });
  }
}
