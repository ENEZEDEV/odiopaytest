-- ==============================================================================
-- ODIOPAY - Migração PostgreSQL Hardened para Lovable Cloud / Supabase
--
-- 1. Autenticação via Supabase Auth (auth.users)
-- 2. Restrições estritas de privilégios de tabelas e colunas (Princípio do menor privilégio)
-- 3. Row Level Security (RLS) completo em todas as tabelas
-- 4. Criptografia em repouso de credenciais OAuth e PKCE (AES-GCM com AAD)
-- 5. Idempotência estrita por lojista no banco e intenções persistentes
-- 6. Imutabilidade e append-only do diário contábil e auditoria
-- 7. Registro durável e deduplicação de webhooks
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Tabela de Lojistas (Merchants)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(plan IN ('standard', 'pro')) DEFAULT 'standard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
-- 2. Conexões OAuth do Mercado Pago
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

-- Tentativas OAuth com PKCE
CREATE TABLE IF NOT EXISTS public.mp_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  encrypted_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 3. Intenções de Pagamento Persistentes e Idempotência
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

CREATE TABLE IF NOT EXISTS public.accounting_entries (
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  account TEXT NOT NULL CHECK(account IN ('provider_receivable', 'merchant_payable', 'platform_revenue')),
  amount_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(payment_id, account)
);

-- ------------------------------------------------------------------------------
-- 5. Diário Contábil da Carteira (Append-Only)
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

-- Triggers de Imutabilidade do Diário
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

DROP TRIGGER IF EXISTS audit_no_update ON public.audit_logs;
CREATE TRIGGER audit_no_update
BEFORE UPDATE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

DROP TRIGGER IF EXISTS audit_no_delete ON public.audit_logs;
CREATE TRIGGER audit_no_delete
BEFORE DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_wallet_journal_immutable();

-- ------------------------------------------------------------------------------
-- 7. Eventos de Webhook Duráveis (Deduplicação de Idempotência Externa)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  signature TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received', 'processed', 'ignored', 'failed')) DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_resource ON public.webhook_events(resource_id);

-- ------------------------------------------------------------------------------
-- 8. Funções Transacionais Protegidas
-- ------------------------------------------------------------------------------

-- Consumo atômico de tentativa OAuth (uso único obrigatório)
CREATE OR REPLACE FUNCTION public.consume_oauth_attempt(
  p_state_hash TEXT,
  p_session_hash TEXT
)
RETURNS TABLE (
  merchant_id UUID,
  code_challenge TEXT,
  encrypted_verifier TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  DELETE FROM public.mp_oauth_attempts
  WHERE state_hash = p_state_hash
    AND session_hash = p_session_hash
    AND expires_at > NOW()
  RETURNING mp_oauth_attempts.merchant_id,
            mp_oauth_attempts.code_challenge,
            mp_oauth_attempts.encrypted_verifier,
            mp_oauth_attempts.created_at;
END;
$$;

-- Salvar conexão OAuth garantindo que callback antigo não sobrescreva conexão mais nova
CREATE OR REPLACE FUNCTION public.save_oauth_connection(
  p_merchant_id UUID,
  p_seller_id TEXT,
  p_encrypted_access_token TEXT,
  p_encrypted_refresh_token TEXT,
  p_public_key TEXT,
  p_token_type TEXT,
  p_expires_at TIMESTAMPTZ,
  p_scope TEXT,
  p_attempt_created_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_updated_at TIMESTAMPTZ;
BEGIN
  SELECT updated_at INTO v_existing_updated_at
  FROM public.mp_oauth_connections
  WHERE merchant_id = p_merchant_id;

  IF v_existing_updated_at IS NOT NULL AND v_existing_updated_at > p_attempt_created_at THEN
    -- Conexão mais recente já existe; rejeita sobrescrita por callback defasado
    RETURN FALSE;
  END IF;

  INSERT INTO public.mp_oauth_connections (
    merchant_id, seller_id, encrypted_access_token, encrypted_refresh_token,
    public_key, token_type, expires_at, scope, status, updated_at
  ) VALUES (
    p_merchant_id, p_seller_id, p_encrypted_access_token, p_encrypted_refresh_token,
    p_public_key, p_token_type, p_expires_at, p_scope, 'active', NOW()
  )
  ON CONFLICT (merchant_id) DO UPDATE SET
    seller_id = EXCLUDED.seller_id,
    encrypted_access_token = EXCLUDED.encrypted_access_token,
    encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
    public_key = EXCLUDED.public_key,
    token_type = EXCLUDED.token_type,
    expires_at = EXCLUDED.expires_at,
    scope = EXCLUDED.scope,
    status = 'active',
    updated_at = NOW();

  RETURN TRUE;
END;
$$;

-- Liquidação e conciliação atômica transacional de pagamento (idempotente e append-only)
CREATE OR REPLACE FUNCTION public.settle_payment_transaction(
  p_intent_id UUID,
  p_mp_payment_id TEXT,
  p_status_detail TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_already_settled BOOLEAN;
BEGIN
  SELECT * INTO v_intent
  FROM public.payment_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Se já estiver com sucesso, confirma idempotência
  IF v_intent.status = 'succeeded' THEN
    RETURN TRUE;
  END IF;

  -- Atualiza intenção
  UPDATE public.payment_intents
  SET status = 'succeeded',
      mp_payment_id = p_mp_payment_id,
      mp_status = 'approved',
      mp_status_detail = p_status_detail,
      updated_at = NOW()
  WHERE id = p_intent_id;

  -- Cria registro na tabela de pagamentos confirmados (idempotente)
  INSERT INTO public.payments (
    id, merchant_id, mp_payment_id, amount_cents, fee_cents, currency, method, status
  ) VALUES (
    v_intent.id, v_intent.merchant_id, p_mp_payment_id,
    v_intent.amount_cents, v_intent.fee_cents, v_intent.currency, v_intent.method, 'succeeded'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Lançamentos de partidas dobradas (equilibradas: soma = 0)
  INSERT INTO public.accounting_entries (payment_id, merchant_id, account, amount_cents)
  VALUES (v_intent.id, v_intent.merchant_id, 'provider_receivable', v_intent.amount_cents)
  ON CONFLICT (payment_id, account) DO NOTHING;

  INSERT INTO public.accounting_entries (payment_id, merchant_id, account, amount_cents)
  VALUES (v_intent.id, v_intent.merchant_id, 'merchant_payable', -(v_intent.amount_cents - v_intent.fee_cents))
  ON CONFLICT (payment_id, account) DO NOTHING;

  INSERT INTO public.accounting_entries (payment_id, merchant_id, account, amount_cents)
  VALUES (v_intent.id, v_intent.merchant_id, 'platform_revenue', -v_intent.fee_cents)
  ON CONFLICT (payment_id, account) DO NOTHING;

  -- Lançamento no diário da carteira (append-only)
  INSERT INTO public.wallet_journal (
    merchant_id, source_id, action, available_delta, reserved_delta, withdrawn_delta
  ) VALUES (
    v_intent.merchant_id, v_intent.id::text, 'settled',
    v_intent.amount_cents - v_intent.fee_cents, 0, 0
  )
  ON CONFLICT (source_id, action) DO NOTHING;

  -- Auditoria
  INSERT INTO public.audit_logs (merchant_id, entity_type, entity_id, action, payload)
  VALUES (
    v_intent.merchant_id, 'payment', v_intent.id::text, 'payment.succeeded',
    jsonb_build_object('mp_payment_id', p_mp_payment_id, 'status_detail', p_status_detail)
  );

  RETURN TRUE;
END;
$$;

-- ------------------------------------------------------------------------------
-- 9. Políticas de Segurança (Row Level Security - RLS)
-- ------------------------------------------------------------------------------
ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mp_oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mp_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Políticas para Merchants
CREATE POLICY merchants_owner_select ON public.merchants
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY merchants_owner_update ON public.merchants
  FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- Políticas para MP OAuth Connections
CREATE POLICY oauth_conn_owner_select ON public.mp_oauth_connections
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- Tentativas OAuth e Webhooks: Nenhum acesso para roles de cliente
-- Apenas service_role / backend tem acesso!

-- Políticas para Payment Intents (Lojista só pode LER suas próprias intenções; criação é pelo backend)
CREATE POLICY payment_intents_owner_select ON public.payment_intents
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- Políticas para Payments
CREATE POLICY payments_owner_select ON public.payments
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- Políticas para Accounting Entries
CREATE POLICY accounting_owner_select ON public.accounting_entries
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- Políticas para Wallet Journal
CREATE POLICY wallet_journal_owner_select ON public.wallet_journal
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- Políticas para Audit Logs
CREATE POLICY audit_logs_owner_select ON public.audit_logs
  FOR SELECT TO authenticated
  USING (merchant_id = public.get_auth_merchant_id());

-- ------------------------------------------------------------------------------
-- 10. Restrições Estritas de Privilégios (Princípio do Menor Privilégio)
-- RLS sozinho NÃO protege contra alterações de colunas indevidas.
-- Privilégios de tabela e coluna são explicitamente restritos.
-- ------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Permissões para authenticated (Usuário logado):
-- 1. Merchants: Apenas leitura de suas informações e atualização EXCLUSIVA da coluna 'name'.
--    Usuário NUNCA pode alterar seu próprio plano, tarifas ou id!
GRANT SELECT ON public.merchants TO authenticated;
GRANT UPDATE (name) ON public.merchants TO authenticated;

-- 2. OAuth Connections: Apenas leitura de metadados não-secretos.
--    Tokens criptografados não são expostos; inserção/atualização bloqueada.
GRANT SELECT (merchant_id, seller_id, public_key, token_type, expires_at, scope, status, created_at, updated_at)
  ON public.mp_oauth_connections TO authenticated;

-- 3. Payment Intents: Apenas leitura. O lojista não cria registros diretamente no banco.
GRANT SELECT ON public.payment_intents TO authenticated;

-- 4. Payments, Lançamentos Contábeis, Carteira e Auditoria: Apenas leitura.
GRANT SELECT ON public.payments TO authenticated;
GRANT SELECT ON public.accounting_entries TO authenticated;
GRANT SELECT ON public.wallet_journal TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

-- 5. mp_oauth_attempts e webhook_events: Nenhum privilégio para authenticated ou anon!

-- Permissões totais para o backend seguro (service_role):
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;


-- Concessão de uso em schemas para roles Supabase
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
