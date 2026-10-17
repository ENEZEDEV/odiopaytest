# ODIOPAY — Relatório Técnico de Homologação Lovable Cloud & Supabase

## 1. Visão Geral da Arquitetura
A ODIOPAY foi adaptada para execução em infraestrutura Lovable Cloud e Supabase com foco estrito em segurança financeira, isolamento multitenant, imutabilidade contábil e conformidade com o modelo Mercado Pago Split 1:1 (`application_fee`).

Nenhum dinheiro real é movimentado. O ambiente opera exclusivamente em **homologação** (`live_mode: false`), com chaves de teste (`TEST-...`) e segredos mantidos estritamente no backend.

---

## 2. Correções de Segurança e Conformidade (Commit Atual)

### 2.1 Permissões e Privilégios do Banco de Dados (PostgreSQL)
- **Princípio do Menor Privilégio**: Todos os privilégios foram revogados de `PUBLIC` e `anon`.
- **Restrição de Escrita de Clientes**: O papel `authenticated` possui estritamente acesso de leitura (`SELECT`) em `payment_intents`, `payments`, `accounting_entries`, `wallet_journal` e `audit_logs`. Nenhuma intenção ou lançamento pode ser inserido ou alterado diretamente pelo cliente.
- **Restrição de Privilégio de Coluna**: Em `merchants`, usuários autenticados só podem atualizar o campo `name`. A alteração do campo `plan` é bloqueada em nível de privilégio de coluna no PostgreSQL (`permission denied`).
- **Ocultação de Segredos OAuth**: A tabela `mp_oauth_connections` restringe as colunas visíveis para `authenticated` apenas aos metadados públicos. As colunas `encrypted_access_token` e `encrypted_refresh_token` são inacessíveis para o cliente.
- **Isolamento RLS Multitenant**: Row Level Security ativado em 100% das tabelas públicas com função STABLE `get_auth_merchant_id()` ancorada em `auth.uid()`.
- **Imutabilidade Append-Only**: Triggers em `wallet_journal` e `audit_logs` impedem qualquer comando `UPDATE` ou `DELETE`, disparando exceção `wallet_journal_is_immutable`.

### 2.2 Hardening do Fluxo OAuth com PKCE
- **Verificador PKCE Criptografado**: O `code_verifier` é cifrado com AES-256-GCM antes de ser persistido em `mp_oauth_attempts`, utilizando AAD vinculado ao `merchant_id` e ao hash do `state`.
- **Vínculo de Sessão**: Cada tentativa OAuth é amarrada ao hash da sessão autenticada (`session_hash = sha256(user.id)`).
- **Consumo Atômico de Uso Único**: A função `consume_oauth_attempt` consome e deleta a tentativa em um único comando atômico dentro do banco, impedindo reaproveitamento ou concorrência.
- **Proteção Contra Sobrescrita Defasada**: A função `save_oauth_connection` verifica se a conexão já existente possui `updated_at` mais recente que a data de criação da tentativa, impedindo que callbacks antigos sobrescrevam conexões recentes.
- **Validação de Erros**: Toda e qualquer operação de banco verifica explicitamente os retornos de erro antes de responder sucesso.

### 2.3 Pagamentos e Split 1:1 Server-Side
- **Cálculo de Tarifas no Servidor**: O valor de `fee_cents` é derivado exclusivamente no backend com base no plano registrado (`standard` ou `pro`) e no método (`pix` ou `card`), usando aritmética inteira exata em centavos com arredondamento seguro via `BigInt`. Tarifas informadas pelo cliente são completamente ignoradas.
- **Idempotência Transacional no Banco**: Proteção por chave composta `UNIQUE(merchant_id, idempotency_key)` e hash de requisição SHA-256. Parâmetros divergentes retornam HTTP 409 `idempotency_conflict`. Requisições concorrentes são deduplicadas no banco.
- **Tratamento de Timeouts e Reconciliação**: Em caso de timeout de rede com o gateway Mercado Pago, o sistema consulta `GET /v1/payments/search?external_reference=${intent_id}`. Caso nenhum pagamento seja localizado, a intenção permanece em `requires_reconciliation`. Uma busca vazia **não autoriza** criar outra cobrança.
- **Validação Upstream**: Na criação e na reconciliação, são conferidos: ambiente de teste (`live_mode: false`), recebedor (`collector_id` igual ao `seller_id`), valor (`transaction_amount`), moeda (`currency_id = 'BRL'`), referência externa e método.

### 2.4 Webhooks com Validação Oficial e Persistência Durável
- **Assinatura HMAC-SHA256**: Validação estrita do cabeçalho `x-signature` (`ts` e `v1`) e `x-request-id` através do manifest oficial do Mercado Pago em tempo constante (`timingSafeEqual`).
- **Persistência Durável Prévia**: O evento de webhook é gravado na tabela `webhook_events` com status `received` antes de qualquer execução externa.
- **Deduplicação de Eventos**: Tentativas repetidas com o mesmo identificador de evento retornam `already_processed` de forma segura sem reprocessamento.
- **Liquidação Transacional**: Consulta à API Mercado Pago com token do vendedor e chamada à rotina `settle_payment_transaction`, que atualiza a intenção, gera partidas dobradas equilibradas (soma = 0) e registra a entrada `settled` no diário imutável da carteira.

---

## 3. Resultados dos Testes Automatizados (118 Testes, 100% Aprovados)

1. **Testes do Núcleo Original ODIOPAY** (`test/*.test.js`):
   - **105 testes executados, 105 aprovados (0 falhas)**.
   - Cobrem regras matemáticas em centavos, livros contábeis com partidas dobradas, concorrência (20 pedidos simultâneos, 8 conexões de banco concorrentes, 8 saques simultâneos) e segurança do dashboard.

2. **Testes de RLS e Privilégios PostgreSQL** (`tests/postgresql-cloud.test.js`):
   - **6 testes executados contra PostgreSQL 17 real, 6 aprovados (0 falhas)**:
     1. Isolamento RLS entre dois lojistas em `merchants`.
     2. Isolamento RLS entre dois lojistas em `payment_intents`.
     3. Restrição de privilégios de coluna (usuário não pode alterar seu próprio plano).
     4. Restrição de escrita direta (usuário não pode inserir em `payment_intents`).
     5. Ocultação de colunas sensíveis em `mp_oauth_connections`.
     6. Bloqueio por trigger contra `UPDATE` e `DELETE` em `wallet_journal`.

3. **Testes de Edge Functions e Idempotência** (`tests/edge-functions-cloud.test.js`):
   - **7 testes executados, 7 aprovados (0 falhas)**:
     1. Comissão adulterada: cliente tenta zerar taxa e servidor recalcula conforme o plano.
     2. Idempotência e Repetição (Replay idêntico no banco).
     3. Idempotência e Resposta Divergente (Detecção de conflito 409).
     4. Concorrência com 10 chamadas simultâneas (exatamente 1 cobrança aceita no banco).
     5. Timeout de rede com retenção em `requires_reconciliation`.
     6. Webhook com assinatura HMAC inválida rejeitado.
     7. Webhook válido com persistência durável, liquidação transacional e deduplicação de replay.

---

## 4. Matriz de Componentes: Operacional vs. Simulado vs. Desabilitado

| Funcionalidade | Estado | Descrição |
| :--- | :--- | :--- |
| **Interface Dark e Branding NZ DEV** | **Operacional** | Layout `#0c0d10`, tipografia, logo `nz-dev.jpg` e créditos NZ DEV preservados. |
| **Banco PostgreSQL e RLS** | **Operacional** | Tabelas com isolamento multitenant estrito, triggers append-only e restrições de coluna. |
| **Cálculo de Tarifas e Partidas Dobradas** | **Operacional** | Cálculo server-side exato em centavos para Standard e Pro com partidas dobradas equilibradas. |
| **Idempotência e Concorrência** | **Operacional** | Proteção atômica no banco por chave e digest SHA-256 com deduplicação de instâncias. |
| **Edge Functions Deno** | **Operacional** | `mp-oauth-begin`, `mp-oauth-callback`, `mp-payments-create` e `mp-webhook` configuradas e validadas. |
| **Simulador de Saques e Carteira Demo** | **Simulado** | Indicado claramente como saldo fictício de sandbox. No modelo Split 1:1, a liquidação real ocorre na conta Mercado Pago do vendedor. |
| **Webhooks e Reconciliação Upstream** | **Homologação** | Mecanismo implementado e verificado; ativo com chaves de teste Mercado Pago em homologação. |
| **Movimentação de Dinheiro Real** | **Desabilitado** | Credenciais de produção estritamente proibidas (`TEST-...` obrigatório e `live_mode: false`). |
