import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL CHECK(plan IN ('standard','pro'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS api_keys (
      digest TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS provider_payments (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL CHECK(currency='BRL'), method TEXT NOT NULL CHECK(method IN ('pix','card')),
      status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      provider_id TEXT NOT NULL UNIQUE REFERENCES provider_payments(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
      fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
      currency TEXT NOT NULL CHECK(currency='BRL'), method TEXT NOT NULL CHECK(method IN ('pix','card')),
      status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(merchant_id, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS payments_merchant ON payments(merchant_id,created_at,id);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, payment_id TEXT NOT NULL REFERENCES payments(id), received_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS accounting_entries (
      payment_id TEXT NOT NULL REFERENCES payments(id),
      account TEXT NOT NULL CHECK(account IN ('provider_receivable','merchant_payable','platform_revenue')),
      amount_cents INTEGER NOT NULL, PRIMARY KEY(payment_id,account)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      payment_id TEXT NOT NULL REFERENCES payments(id), action TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sandbox_destinations (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS wallet_settlements (
      payment_id TEXT PRIMARY KEY REFERENCES payments(id), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      destination_id TEXT NOT NULL REFERENCES sandbox_destinations(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
      status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed')),
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(merchant_id,idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS wallet_journal (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      source_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('settled','reserved','succeeded','failed')),
      available_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL, withdrawn_delta INTEGER NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(source_id,action),
      CHECK (
        (action='settled' AND available_delta>=0 AND reserved_delta=0 AND withdrawn_delta=0) OR
        (action='reserved' AND available_delta<0 AND reserved_delta=-available_delta AND withdrawn_delta=0) OR
        (action='succeeded' AND available_delta=0 AND reserved_delta<0 AND withdrawn_delta=-reserved_delta) OR
        (action='failed' AND available_delta>0 AND reserved_delta=-available_delta AND withdrawn_delta=0)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS wallet_merchant ON wallet_journal(merchant_id);
    CREATE INDEX IF NOT EXISTS withdrawals_merchant ON withdrawals(merchant_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON wallet_journal
      BEGIN SELECT RAISE(ABORT, 'journal_is_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON wallet_journal
      BEGIN SELECT RAISE(ABORT, 'journal_is_append_only'); END;
    CREATE TABLE IF NOT EXISTS mp_oauth_epochs (
      merchant_id TEXT PRIMARY KEY REFERENCES merchants(id), epoch INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mp_oauth_attempts (
      state_hash TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
      session_hash TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      sealed TEXT NOT NULL, UNIQUE(merchant_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mp_connections (
      merchant_id TEXT PRIMARY KEY REFERENCES merchants(id), seller_id TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, sealed TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','refreshing','reconnect_required'))
    ) STRICT;
    PRAGMA user_version = 3;
  `);
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
