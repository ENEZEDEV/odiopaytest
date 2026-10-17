# ODIOPAY — Lovable Cloud & Supabase Edge Functions (Homologação)

Plataforma de pagamentos com split 1:1 via **Mercado Pago Payments API + OAuth com PKCE**, adaptada para **Lovable Cloud** e **Supabase**.

> **ATENÇÃO:** Ambiente estritamente em **homologação/sandbox**. Pagamentos reais estão desabilitados por design e credenciais de produção (`APP_USR-`) são bloqueadas em tempo de execução.

---

## 🔒 Arquitetura de Segurança Implementada

1. **Autenticação e Identidade**:
   - Autenticação obrigatória via **Supabase Auth** (`Authorization: Bearer <jwt>`).
   - O `merchant_id` é rigorosamente derivado no servidor a partir de `auth.uid() = auth_user_id`. Nenhuma informação de identidade fornecida pelo cliente no corpo JSON é confiada.

2. **Cálculo de Comissão Server-Side**:
   - As tarifas são calculadas exclusivamente no servidor conforme o plano do lojista (`standard` ou `pro`):
     - **Standard**: PIX: R$ 1,00 fixo; Cartão: 3,99% + R$ 0,39.
     - **Pro**: PIX: R$ 0,50 fixo; Cartão: 2,99% + R$ 0,30.
   - Qualquer tentativa do cliente de injetar `fee_cents`, `commissionCents` ou `application_fee` é ignorada e substituída pela regra legítima.

3. **Criptografia de Credenciais OAuth**:
   - Os tokens de acesso e refresh do Mercado Pago são cifrados em repouso usando **AES-256-GCM** com chave de 256 bits (`TOKEN_ENCRYPTION_KEY`) e dados contextuais adicionais (AAD) vinculados ao ID do lojista.

4. **Intenção Persistente e Idempotência**:
   - Tabela `payment_intents` persistida antes da comunicação upstream com Mercado Pago.
   - Restrição única composta `(merchant_id, idempotency_key)` e hash de requisição (`request_digest`) para prevenir repetições conflitantes ou cobranças duplicadas.
   - Deduplicação de concorrência em tempo real.

5. **Reconciliação de Respostas Incertas**:
   - Em caso de timeout de rede, desconexão ou erro 5xx do gateway upstream, o sistema não descarta a transação nem repete cegamente a cobrança.
   - Executa consulta de reconciliação (`GET /v1/payments/search?external_reference=${intent_id}`) antes de emitir resposta, sincronizando o estado com precisão.

6. **Row Level Security (RLS) no PostgreSQL**:
   - RLS ativo em 100% das tabelas (`merchants`, `mp_oauth_connections`, `payment_intents`, `payments`, `accounting_entries`, `wallet_journal`, `audit_logs`).
   - Políticas restritivas garantem isolamento hermético entre lojistas.
   - Triggers bloqueiam qualquer `UPDATE` ou `DELETE` no diário contábil e auditoria (Append-Only rigoroso).

---

## 📁 Estrutura de Arquivos

```
odiopay-cloud/
├── supabase/
│   ├── migrations/
│   │   └── 20261017000000_odiopay_cloud_schema.sql  # Schema PostgreSQL, RLS e triggers
│   └── functions/
│       ├── mp-payments-create/index.ts              # Criação de cobrança com split 1:1 e reconciliação
│       ├── mp-oauth-begin/index.ts                  # Início de OAuth com PKCE S256
│       ├── mp-oauth-callback/index.ts               # Troca de código e cifragem AES-GCM
│       └── mp-webhook/index.ts                      # Receptor seguro de webhooks
├── src/
│   ├── security/
│   │   └── token-vault.js                           # Implementação AES-256-GCM com AAD
│   ├── finance/
│   │   └── tariffs.js                               # Cálculo estrito de comissões em centavos
│   └── services/
│       └── payment-intent-service.js                # Orquestrador de ciclo de vida e reconciliação
├── tests/
│   └── migrated-cloud.test.js                       # 4 suítes de testes de segurança Cloud
├── public/                                          # UI dark original com créditos NZ DEV
│   ├── dark.css
│   ├── index.html
│   ├── nz-dev.jpg
│   └── app.js
└── package.json
```

---

## 🧪 Suíte de Testes Automatizados

### Testes da Versão Migrada Cloud:
```bash
node --test tests/migrated-cloud.test.js
```
Cenários validados:
1. **Acesso entre lojistas**: Bloqueio de lojistas não autorizados e isolamento de dados.
2. **Comissão adulterada**: Imutabilidade das taxas e cálculo estrito no servidor.
3. **Duplicação concorrente**: 10 requisições simultâneas com mesma chave geram 1 cobrança e 9 replays idênticos.
4. **Falhas de rede e reconciliação**: Recuperação de transações upstream após timeout/504 sem duplicidade.

### Testes Originais Node/SQLite:
```bash
cd odiopay-source && node --test
```
105 testes unitários e de integração contábil aprovados com zero falhas.
