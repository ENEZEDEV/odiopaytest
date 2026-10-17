# ODIOPAY — Relatório de Migração e Hardening para Lovable Cloud (Supabase)

Data: 17 de Outubro de 2026  
Status: **Homologação Estrita (Sandbox) — NÃO PUBLICADO**  
Repositório Git: Preparado localmente e pronto para push no GitHub.

---

## 1. Correções Arquiteturais Implementadas

### A. Autenticação e Derivação de Identidade
- **Eliminação de Confiança no Cliente**: O campo `merchantId` enviado no corpo da requisição não é utilizado para determinar quem está efetuando a transação.
- **Supabase Auth JWT**: A Edge Function extrai o token `Authorization: Bearer <JWT>`, consulta `auth.getUser()`, e deriva o lojista via chave estrangeira estrita no banco:
  ```sql
  SELECT id, plan FROM merchants WHERE auth_user_id = auth.uid();
  ```
- **Rejeição Automática**: Qualquer requisição sem sessão válida ou sem lojista vinculado retorna HTTP 401/403.

### B. Cálculo de Comissão Exclusivamente no Servidor
- **Taxas Imutáveis pelo Cliente**: O cliente não pode injetar `fee_cents`, `commissionCents` ou `application_fee`.
- **Regras Contábeis Aplicadas (em centavos com arredondamento exato)**:
  - **Plano Standard**:
    - PIX: R$ 1,00 fixo (100 centavos).
    - Cartão de Crédito: 3,99% (399 bps) + R$ 0,39 (39 centavos).
  - **Plano Pro**:
    - PIX: R$ 0,50 fixo (50 centavos).
    - Cartão de Crédito: 2,99% (299 bps) + R$ 0,30 (30 centavos).
- **Fórmula**: `proportional = (amountCents * bps + 9999n) / 10000n; fee = min(amountCents, proportional + fixedCents)`.

### C. Criptografia em Repouso de Credenciais OAuth do Vendedor
- Tokens de acesso e refresh do vendedor (`access_token`, `refresh_token`) são cifrados usando **AES-256-GCM** com vetor de inicialização (IV) de 12 bytes gerado com `crypto.getRandomValues()` e tag de autenticação de 16 bytes.
- **Dados Contextuais Autenticados (AAD)**: O envelope criptográfico vincula o token ao contexto `mp:oauth:${merchant_id}:${seller_id}`, impedindo que um token seja usado por outro lojista mesmo se o banco fosse comprometido.
- **Homologação Obrigatória**: É validado que o token inicia obrigatoriamente com `TEST-`. Tokens de produção (`APP_USR-`) são bloqueados pelo backend.

### D. Intenção Persistente, Idempotência e Concorrência
- Tabela `payment_intents` persistida antes de qualquer comunicação externa.
- Restrição única composta `UNIQUE(merchant_id, idempotency_key)` e hash SHA-256 de requisição (`request_digest`).
- Deduplicação em tempo de execução para requisições concorrentes disparadas simultaneamente com a mesma chave de idempotência.

### E. Reconciliação de Respostas Incertas (Timeout / Rede / 5xx)
- Em caso de timeout (`AbortController` 15s), queda de conexão ou HTTP 5xx do Mercado Pago, a Edge Function não falha cegamente nem gera nova cobrança:
  1. Executa busca upstream por referência externa:
     `GET https://api.mercadopago.com/v1/payments/search?external_reference=${intent_id}`
  2. Se a cobrança já foi recebida e processada no gateway, sincroniza o status (`succeeded` ou `requires_action`) e retorna a resposta válida.
  3. Se a busca não for conclusiva, marca a intenção com status `requires_reconciliation`, evitando duplicação.

### F. Sanitização Rigorosa de Respostas (DTO) e Erros
- Nenhuma chave de banco, token de acesso, credencial do vendedor ou stack trace interno é retornado ao cliente.
- Retorno padronizado:
  ```json
  {
    "payment": {
      "id": "uuid",
      "amountCents": 10000,
      "feeCents": 100,
      "netCents": 9900,
      "currency": "BRL",
      "method": "pix",
      "status": "requires_action",
      "qrCode": "...",
      "qrCodeBase64": "...",
      "ticketUrl": "...",
      "createdAt": "2026-10-17T...",
      "replayed": false,
      "environment": "sandbox"
    }
  }
  ```

---

## 2. Row Level Security (RLS) no PostgreSQL

Todas as tabelas possuem RLS habilitado:
- `merchants`: `auth.uid() = auth_user_id`
- `mp_oauth_connections`: `merchant_id = get_auth_merchant_id()`
- `payment_intents`: `merchant_id = get_auth_merchant_id()`
- `payments`: `merchant_id = get_auth_merchant_id()`
- `accounting_entries`: `merchant_id = get_auth_merchant_id()`
- `wallet_journal`: `merchant_id = get_auth_merchant_id()` com triggers de bloqueio para `UPDATE` e `DELETE` (Append-Only)
- `audit_logs`: `merchant_id = get_auth_merchant_id()` com triggers de bloqueio para `UPDATE` e `DELETE` (Append-Only)

---

## 3. Resultados da Execução de Testes

### A. Testes da Versão Migrada Cloud (`tests/migrated-cloud.test.js`):
- `ok 1 - 1. Acesso entre lojistas (Cross-merchant isolation): Nega acesso a lojista não autorizado` (3.5ms)
- `ok 2 - 2. Comissão adulterada (Tampered commission): Rejeita/ignora comissão vinda do cliente e recalcula estritamente no servidor` (2.3ms)
- `ok 3 - 3. Duplicação concorrente (Concurrent duplicate requests): 10 chamadas simultâneas com mesma idempotency_key resultam em 1 cobrança e respostas consistentes` (27.0ms)
- `ok 4 - 4. Falhas de rede e reconciliação de respostas incertas: Timeout/504 recupera estado sem duplicar cobrança` (0.8ms)
**Total: 4 aprovados, 0 falhas.**

### B. Testes Originais da ODIOPAY (Node/SQLite):
- **105 testes executados e aprovados com 100% de sucesso (0 falhas).**

---

## 4. Instruções para Sincronização com o GitHub

O repositório Git foi inicializado e commitado localmente no diretório `/tmp/odiopay-cloud`.
Para enviar o código para o seu repositório no GitHub:

```bash
# 1. No terminal do seu projeto:
cd /tmp/odiopay-cloud

# 2. Conecte o repositório remoto do GitHub (substitua pela sua URL):
git remote add origin https://github.com/SEU_USUARIO/odiopay.git

# 3. Envie para o branch principal:
git push -u origin main
```
