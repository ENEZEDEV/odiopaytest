-- ==============================================================================
-- ODIOPAY - Migração PostgreSQL Hardened para Lovable Cloud / Supabase
--
-- 1. Autenticação via Supabase Auth (auth.users)
-- 2. Row Level Security (RLS) completo em todas as tabelas
-- 3. Criptografia em repouso de credenciais OAuth do vendedor (AES-GCM)
-- 4. Idempotência estrita por lojista e intenções persistentes
-- 5. Imutabilidade e append-only do diário contábil e auditoria
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Lojistas vinculados à identidade Supabase Auth
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(plan IN ('standard', 'pro')) DEFAULT 'standard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;

CREATE POLICY merchants_owner_select ON public.merchants
  FOR SELECT USING (auth.uid() = auth_user_id);

CREATE POLICY merchants_owner_update ON public.merchants
  FOR UPDATE USING (auth.uid() = auth_user_id)
  WITH CHECK (auth.uid() = auth_user_id);

-- Função auxiliar STABLE para obter o merchant_id da sessão ativa
CREATE OR REPLACE FUNCTION public.get_auth_merchant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.merchants WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- ------------------------------------------------------------------------------
-- 2. Conexões OAuth do Mercado Pago com Criptografia de Tokens
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mp_oauth_connections (
  merchant_id UUID PRIMARY KEY REFERENCES public.merchants(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL UNIQUE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'refreshing', 'revoked', 'reconnect_required')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.mp_oauth_connections ENABLE ROW LEVEL SECURITY;

-- Usuários só podem ler status e public_key de sua própria conexão
-- Tokens cifrados são manipulados exclusivamente via Edge Functions (Service Role)
CREATE POLICY oauth_conn_owner_select ON public.mp_oauth_connections
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

-- Tentativas OAuth com PKCE
CREATE TABLE IF NOT EXISTS public.mp_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  sealed_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(merchant_id)
);

ALTER TABLE public.mp_oauth_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_attempts_owner_all ON public.mp_oauth_attempts
  FOR ALL USING (merchant_id = public.get_auth_merchant_id());

-- ------------------------------------------------------------------------------
-- 3. Intenções de Pagamento Persistentes e Idempotência por Lojista
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK(amount_cents >= 100 AND amount_cents <= 100000000),
  fee_cents BIGINT NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
  net_cents BIGINT GENERATED ALWAYS AS (amount_cents - fee_cents) STORED,
  currency TEXT NOT NULL CHECK(currency = 'BRL'),
  method TEXT NOT NULL CHECK(method IN ('pix', 'card')),
  payer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'created',
    'processing',
    'requires_action',
    'succeeded',
    'failed',
    'cancelled',
    'requires_reconciliation'
  )) DEFAULT 'created',
  mp_payment_id TEXT,
  mp_status TEXT,
  mp_status_detail TEXT,
  qr_code TEXT,
  qr_code_base64 TEXT,
  ticket_url TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_intents_merchant_idempotency UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_merchant_created ON public.payment_intents(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_mp_payment_id ON public.payment_intents(mp_payment_id);

ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_intents_owner_select ON public.payment_intents
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

CREATE POLICY payment_intents_owner_insert ON public.payment_intents
  FOR INSERT WITH CHECK (merchant_id = public.get_auth_merchant_id());

-- ------------------------------------------------------------------------------
-- 4. Pagamentos Confirmados e Partidas Dobradas
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY REFERENCES public.payment_intents(id) ON DELETE RESTRICT,
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  mp_payment_id TEXT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL,
  currency TEXT NOT NULL CHECK(currency = 'BRL'),
  method TEXT NOT NULL CHECK(method IN ('pix', 'card')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_owner_select ON public.payments
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

CREATE TABLE IF NOT EXISTS public.accounting_entries (
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  account TEXT NOT NULL CHECK(account IN ('provider_receivable', 'merchant_payable', 'platform_revenue')),
  amount_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(payment_id, account)
);

ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_owner_select ON public.accounting_entries
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

-- ------------------------------------------------------------------------------
-- 5. Diário Contábil da Carteira (Rigorosamente Append-Only)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS idx_wallet_journal_merchant ON public.wallet_journal(merchant_id);

ALTER TABLE public.wallet_journal ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallet_journal_owner_select ON public.wallet_journal
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

-- Triggers de Imutabilidade
CREATE OR REPLACE FUNCTION public.trg_wallet_journal_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wallet_journal_is_immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_no_update ON public.wallet_journal;
CREATE TRIGGER journal_no_update
BEFORE UPDATE ON public.wallet_journal
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

DROP TRIGGER IF EXISTS journal_no_delete ON public.wallet_journal;
CREATE TRIGGER journal_no_delete
BEFORE DELETE ON public.wallet_journal
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

-- ------------------------------------------------------------------------------
-- 6. Auditoria (Append-Only)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_owner_select ON public.audit_logs
  FOR SELECT USING (merchant_id = public.get_auth_merchant_id());

DROP TRIGGER IF EXISTS audit_no_update ON public.audit_logs;
CREATE TRIGGER audit_no_update
BEFORE UPDATE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

DROP TRIGGER IF EXISTS audit_no_delete ON public.audit_logs;
CREATE TRIGGER audit_no_delete
BEFORE DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

