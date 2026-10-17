-- ==============================================================================
-- ODIOPAY - Migração PostgreSQL para Lovable Cloud / Supabase
-- Preserva regras financeiras, idempotência, auditoria e imutabilidade contábil
-- ==============================================================================

-- 1. Lojistas e chaves
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(plan IN ('standard', 'pro'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  digest TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
);

-- 2. Pagamentos do provedor e cobranças locais
CREATE TABLE IF NOT EXISTS provider_payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL CHECK(currency = 'BRL'),
  method TEXT NOT NULL CHECK(method IN ('pix', 'card')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL UNIQUE REFERENCES provider_payments(id),
  amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
  fee_cents BIGINT NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
  currency TEXT NOT NULL CHECK(currency = 'BRL'),
  method TEXT NOT NULL CHECK(method IN ('pix', 'card')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant_created ON payments(merchant_id, created_at DESC, id DESC);

-- 3. Eventos e partidas dobradas
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_entries (
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  account TEXT NOT NULL CHECK(account IN ('provider_receivable', 'merchant_payable', 'platform_revenue')),
  amount_cents BIGINT NOT NULL,
  PRIMARY KEY(payment_id, account)
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Carteira, liquidação e saques simulados
CREATE TABLE IF NOT EXISTS sandbox_destinations (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
);

CREATE TABLE IF NOT EXISTS wallet_settlements (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES sandbox_destinations(id),
  amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'succeeded', 'failed')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_merchant_created ON withdrawals(merchant_id, created_at DESC, id DESC);

-- 5. Diário contábil da carteira (Append-Only)
CREATE TABLE IF NOT EXISTS wallet_journal (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('settled', 'reserved', 'succeeded', 'failed')),
  available_delta BIGINT NOT NULL,
  reserved_delta BIGINT NOT NULL,
  withdrawn_delta BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, action),
  CHECK (
    (action = 'settled' AND available_delta >= 0 AND reserved_delta = 0 AND withdrawn_delta = 0) OR
    (action = 'reserved' AND available_delta < 0 AND reserved_delta = -available_delta AND withdrawn_delta = 0) OR
    (action = 'succeeded' AND available_delta = 0 AND reserved_delta < 0 AND withdrawn_delta = -reserved_delta) OR
    (action = 'failed' AND available_delta > 0 AND reserved_delta = -available_delta AND withdrawn_delta = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_journal_merchant ON wallet_journal(merchant_id);

-- Gatilhos para assegurar que o diário contábil seja rigorosamente append-only
CREATE OR REPLACE FUNCTION trg_wallet_journal_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'journal_is_append_only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_no_update ON wallet_journal;
CREATE TRIGGER journal_no_update
BEFORE UPDATE ON wallet_journal
FOR EACH ROW EXECUTE FUNCTION trg_wallet_journal_immutable();

DROP TRIGGER IF EXISTS journal_no_delete ON wallet_journal;
CREATE TRIGGER journal_no_delete
BEFORE DELETE ON wallet_journal
FOR EACH ROW EXECUTE FUNCTION trg_wallet_journal_immutable();

-- 6. Mercado Pago OAuth (PKCE, Épocas e Conexões Cifradas)
CREATE TABLE IF NOT EXISTS mp_oauth_epochs (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mp_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,
  sealed TEXT NOT NULL,
  UNIQUE(merchant_id)
);

CREATE TABLE IF NOT EXISTS mp_connections (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,
  sealed TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'refreshing', 'reconnect_required'))
);
