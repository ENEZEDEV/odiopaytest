import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { requireThat } from './errors.js';
import { digest } from './security.js';
import { exactObject, idempotencyKey, isId, MAX_AMOUNT } from './validation.js';

function safeAmount(value) {
  requireThat(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 500, 'balance_integrity_error');
  return Number(value);
}

function publicWithdrawal(row) {
  return { id: row.id, destinationId: row.destination_id, amountCents: row.amount_cents,
    currency: 'BRL', status: row.status, createdAt: row.created_at, environment: 'sandbox' };
}

export class Wallet {
  constructor(db) { this.db = db; }
  balance(merchantId) {
    // A single SQL statement reads one consistent snapshot, including receivables.
    const query = this.db.prepare(`SELECT
      COALESCE(SUM(available_delta),0) AS available,
      COALESCE(SUM(reserved_delta),0) AS reserved,
      COALESCE(SUM(withdrawn_delta),0) AS withdrawn,
      (SELECT COALESCE(SUM(p.amount_cents-p.fee_cents),0) FROM payments p
       LEFT JOIN wallet_settlements s ON s.payment_id=p.id
       WHERE p.merchant_id=? AND p.status='succeeded' AND s.payment_id IS NULL) AS receivable
      FROM wallet_journal WHERE merchant_id=?`);
    query.setReadBigInts(true);
    const row = query.get(merchantId, merchantId);
    return { availableCents: safeAmount(row.available), reservedCents: safeAmount(row.reserved),
      withdrawnCents: safeAmount(row.withdrawn), receivableCents: safeAmount(row.receivable), currency: 'BRL', environment: 'sandbox' };
  }
  journal(merchantId, sourceId, action, available, reserved, withdrawn) {
    this.db.prepare('INSERT INTO wallet_journal (id,merchant_id,source_id,action,available_delta,reserved_delta,withdrawn_delta,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), merchantId, sourceId, action, available, reserved, withdrawn, new Date().toISOString());
  }
  // Trusted local settlement simulator. No HTTP route can credit a wallet.
  settlePayment(paymentId) {
    requireThat(isId(paymentId), 404, 'not_found');
    return transaction(this.db, () => {
      const p = this.db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
      requireThat(p, 404, 'not_found');
      requireThat(p.status === 'succeeded', 409, 'payment_not_confirmed');
      if (this.db.prepare('SELECT 1 FROM wallet_settlements WHERE payment_id=?').get(paymentId)) return { replayed: true };
      this.db.prepare('INSERT INTO wallet_settlements VALUES (?,?)').run(paymentId, new Date().toISOString());
      this.journal(p.merchant_id, paymentId, 'settled', p.amount_cents - p.fee_cents, 0, 0);
      this.balance(p.merchant_id);
      return { replayed: false };
    });
  }
  destinations(merchantId) {
    return this.db.prepare('SELECT id FROM sandbox_destinations WHERE merchant_id=? AND revoked=0 ORDER BY id').all(merchantId);
  }
  request(merchantId, input, key) {
    exactObject(input, ['amountCents', 'currency', 'destinationId']);
    requireThat(Number.isSafeInteger(input.amountCents) && input.amountCents >= 100 && input.amountCents <= MAX_AMOUNT, 400, 'invalid_amount');
    requireThat(input.currency === 'BRL', 400, 'invalid_currency');
    requireThat(isId(input.destinationId), 400, 'invalid_destination');
    idempotencyKey(key);
    const fingerprint = digest(JSON.stringify({ amountCents: input.amountCents, currency: input.currency, destinationId: input.destinationId }));
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM withdrawals WHERE merchant_id=? AND idempotency_key=?').get(merchantId, key);
      if (previous) {
        requireThat(previous.request_digest === fingerprint, 409, 'idempotency_conflict');
        return { withdrawal: publicWithdrawal(previous), replayed: true };
      }
      requireThat(this.db.prepare('SELECT 1 FROM sandbox_destinations WHERE id=? AND merchant_id=? AND revoked=0').get(input.destinationId, merchantId), 404, 'destination_not_found');
      requireThat(this.balance(merchantId).availableCents >= input.amountCents, 409, 'insufficient_balance');
      const id = randomUUID();
      this.db.prepare('INSERT INTO withdrawals (id,merchant_id,destination_id,amount_cents,status,idempotency_key,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, merchantId, input.destinationId, input.amountCents, 'reserved', key, fingerprint, new Date().toISOString());
      this.journal(merchantId, id, 'reserved', -input.amountCents, input.amountCents, 0);
      return { withdrawal: this.get(merchantId, id), replayed: false };
    });
  }
  get(merchantId, id) {
    requireThat(isId(id), 404, 'not_found');
    const row = this.db.prepare('SELECT * FROM withdrawals WHERE id=? AND merchant_id=?').get(id, merchantId);
    requireThat(row, 404, 'not_found');
    return publicWithdrawal(row);
  }
  list(merchantId) {
    return this.db.prepare('SELECT * FROM withdrawals WHERE merchant_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(merchantId).map(publicWithdrawal);
  }
  // Trusted simulator result. A timeout must stay reserved until reconciliation;
  // only a definitive failure may release the reservation.
  finishWithdrawal(id, status) {
    requireThat(isId(id), 404, 'not_found');
    requireThat(['succeeded', 'failed'].includes(status), 400, 'invalid_withdrawal_status');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id=?').get(id);
      requireThat(row, 404, 'not_found');
      if (row.status === status) return { replayed: true };
      requireThat(row.status === 'reserved', 409, 'invalid_transition');
      this.db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(status, id);
      this.journal(row.merchant_id, id, status, status === 'failed' ? row.amount_cents : 0, -row.amount_cents, status === 'succeeded' ? row.amount_cents : 0);
      this.balance(row.merchant_id);
      return { replayed: false };
    });
  }
}
