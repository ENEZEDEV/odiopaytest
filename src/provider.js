import { randomUUID } from 'node:crypto';
import { requireThat } from './errors.js';

// Simulator only. A real PSP adapter needs network timeouts, durable outbox,
// provider idempotency and reconciliation; never call a remote API in a DB transaction.
export class SandboxProvider {
  constructor(db) { this.db = db; }
  create(merchantId, input) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO provider_payments VALUES (?,?,?,?,?,?)').run(id, merchantId, input.amountCents, input.currency, input.method, 'pending');
    return id;
  }
  get(id) {
    return this.db.prepare('SELECT * FROM provider_payments WHERE id=?').get(id);
  }
  // Trusted local simulator control. Deliberately has no HTTP route.
  settle(id, status) {
    requireThat(['succeeded', 'failed'].includes(status), 400, 'invalid_provider_status');
    const result = this.db.prepare("UPDATE provider_payments SET status=? WHERE id=? AND status='pending'").run(status, id);
    requireThat(result.changes === 1, 409, 'provider_not_pending');
  }
}
