# ODIOPAY — NZ DEV · v0.3

**Desenvolvido por NZ DEV.** Painel dark com identidade NZ DEV, backend Node.js e banco SQLite. [Créditos](AUTHORS.md).

**Decisão para o lançamento:** [split 1:1 com Mercado Pago](docs/SPLIT.md), contas dos vendedores conectadas por OAuth e API própria da ODIOPAY por lojista. A carteira e os saques desta demonstração são simulados; carteira própria não faz parte da primeira versão real. O split real ainda está em preparação.

Novos componentes internos: [OAuth, tokens cifrados e pagamentos de teste com comissão](docs/OAUTH.md). A aplicação ODIOPAY foi criada no Mercado Pago segundo o responsável. A integração externa ainda não foi homologada, e esses componentes não estão expostos nas rotas públicas do painel.

## Abrir o painel

```powershell
node scripts/start-dashboard.js
```

Acesse **http://127.0.0.1:3100** e clique em **Entrar na demonstração**. O painel permite criar cobranças Pix/cartão, simular pagamento e liquidação, acompanhar saldo, reservar saques e simular sucesso ou falha. Há busca, filtros e modelos ilustrativos de tarifas.

Cada sessão ganha uma loja fictícia independente. A sessão expira em uma hora e ao reiniciar o servidor; os dados de demonstração persistem em `data/dashboard.sqlite`, ignorado pelo Git. Sessões usam cookie HttpOnly/SameSite=Strict e verificação de origem/CSRF. O cookie local HTTP não tem Secure; este servidor é restrito ao loopback e não é uma configuração de produção.

O painel usa `/app-api/*`, isolado da API de integração `/v1/*`. Os controles para simular pagamentos e saques somente acessam a loja fictícia da sessão. Não há cadastro de clientes reais nem verificação de identidade nesta versão.

Primeira entrega executável para uma operação brasileira com Pix e cartão. **Somente sandbox local: não processa dinheiro real, não gera QR Pix pagável e não autoriza cartões reais.**

## Executar agora

Requer Node.js 24. Não há pacotes externos para instalar nesta versão.

Na pasta do projeto:

```powershell
node --test
node scripts/demo.js
```

A demonstração cria um banco em memória, uma credencial temporária e um servidor em porta aleatória no loopback. Executa criação → confirmação do simulador → webhook assinado → liquidação → saldo disponível para Pix e cartão. Depois solicita um saque de R$ 50, reserva o valor e simula o sucesso. Ao terminar, encerra o servidor e descarta os dados.

## Servidor local persistente

No PowerShell:

```powershell
$env:ODIOPAY_MODE = 'sandbox'
$env:ODIOPAY_WEBHOOK_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
node scripts/create-merchant.js 'Minha loja' standard
node src/main.js
```

Guarde a chave exibida pela criação do lojista em um local privado. Ela não pode ser recuperada do banco. O servidor atende em `http://127.0.0.1:3100`; o banco fica em `data/odiopay.sqlite`. As variáveis do exemplo valem para o terminal atual. Para manter webhooks válidos entre reinicializações, preserve o mesmo segredo em um gerenciador de segredos local; `.env.example` é apenas uma referência e não é carregado automaticamente.

Em outro terminal, substitua o placeholder pela chave sandbox:

```powershell
$headers = @{
  Authorization = 'Bearer SUA_CHAVE_SANDBOX'
  'Idempotency-Key' = [guid]::NewGuid().ToString()
}
$body = @{ amountCents = 10000; currency = 'BRL'; method = 'pix' } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:3100/v1/payments' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

Para cartão, use `method: "card"` e `cardToken: "tok_sandbox_1234567890123456"`. Esse token é fictício. Não envie dados reais de cartão. A rota de criação deixa a cobrança pendente; a demonstração mostra a confirmação controlada do simulador.

## O que funciona

- Criação, consulta e listagem de cobranças por lojista.
- Autenticação por chave aleatória, armazenada somente como hash; revogação respeitada pela autenticação.
- Valores inteiros em centavos, BRL e limite sandbox entre R$ 1 e R$ 1 milhão.
- Tarifas ilustrativas calculadas no servidor, com regra por plano e meio de pagamento.
- Idempotência persistente por lojista e chave; conflito quando o conteúdo muda.
- Webhooks HMAC-SHA256, janela de cinco minutos, deduplicação e consulta ao estado do simulador.
- Status, evento, lançamentos e auditoria gravados na mesma transação.
- Três lançamentos que somam zero em cada confirmação bem-sucedida.
- Limites de corpo, cabeçalhos e requisições; erros sanitizados.
- Carteira simulada com valores a receber, disponíveis, reservados e sacados.
- Saque com reserva transacional, idempotência e destino sandbox vinculado ao lojista.
- Diário de movimentos que bloqueia UPDATE/DELETE pelo SQL normal. Um administrador do banco ainda pode remover as proteções; não é armazenamento imutável externo.

## API

| Método e caminho | Uso | Autenticação |
| --- | --- | --- |
| `GET /health` | Estado e identificação sandbox | Nenhuma |
| `POST /v1/payments` | Criar cobrança | Bearer + `Idempotency-Key` |
| `GET /v1/payments` | Últimas 100 cobranças do lojista | Bearer |
| `GET /v1/payments/:id` | Consultar cobrança do lojista | Bearer |
| `POST /v1/webhooks/sandbox` | Receber confirmação simulada | HMAC + timestamp |
| `GET /v1/wallet` | Consultar saldo do lojista | Bearer |
| `GET /v1/withdrawal-destinations` | Listar destinos sandbox do lojista | Bearer |
| `POST /v1/withdrawals` | Solicitar saque e reservar saldo | Bearer + `Idempotency-Key` |
| `GET /v1/withdrawals` | Últimos 100 saques do lojista | Bearer |
| `GET /v1/withdrawals/:id` | Consultar saque do lojista | Bearer |

A API `/v1/*` é voltada à comunicação servidor a servidor. Chamadas com cabeçalho `Origin` são rejeitadas; chaves de lojista não devem ser colocadas no navegador. O painel usa sessões próprias de demonstração em `/app-api/*`, sem expor chaves de API.

As tarifas sandbox são exemplos: Standard Pix R$ 1; Pro Pix R$ 0,50; Standard cartão 3,99% + R$ 0,39; Pro cartão 2,99% + R$ 0,30. A parte percentual arredonda para cima no centavo e a tarifa total é limitada ao valor da cobrança. A tarifa fica registrada na criação. **Preços, mensalidades e margem comercial ainda precisam ser definidos.**

## Ler e aprender

Preparação para integração real: [plano de lançamento com split](docs/SPLIT.md). O leitor de pagamentos de teste já tem testes locais de falhas; ainda não foi homologado com a API externa. O [plano anterior de carteira](docs/LAUNCH.md) permanece como referência futura.

Validação completa: `npm run check`. O GitHub Actions está configurado para executar a validação em Linux e Windows. Veja [critérios de entrega e próximos marcos](docs/DELIVERY.md).

1. `src/validation.js`: contrato aceito pela API.
2. `src/payments.js`: regras de criação, tarifas e confirmação.
3. `src/database.js`: persistência e transações.
4. `src/security.js` e `src/http.js`: autenticação, assinatura e limites.
5. `test/payments.test.js`: tentativas de quebra e verificação das regras.
6. `src/wallet.js` e `test/wallet.test.js`: liquidação, saldo, reserva e saque.

## Carteira e saque sandbox

O cadastro local de um novo lojista gera também `destinationId`, um destino fictício pertencente ao lojista. Para solicitar saque, envie `{ "amountCents": 5000, "currency": "BRL", "destinationId": "ID_DO_DESTINO" }` para `POST /v1/withdrawals`.

Uma cobrança confirmada aumenta o valor a receber. Só a liquidação simulada libera o líquido para saque. `Wallet.settlePayment` e `Wallet.finishWithdrawal` são controles do simulador. A API de integração `/v1/*` não expõe esses controles; o painel local `/app-api/*` permite simular resultados somente para a loja fictícia da sessão autenticada, com proteção de origem e CSRF.

Não são cobradas tarifas de saque nesta versão, pois ainda não foram definidas. Destinos não representam contas bancárias reais nem verificação de titularidade. Lojistas antigos sem destino podem usar um novo cadastro sandbox nesta etapa. Veja [regras da carteira](docs/WALLET.md).

Veja [arquitetura e próximos passos](docs/ARCHITECTURE.md), [segurança e limites](docs/SECURITY.md), [resultado dos testes](docs/VALIDATION.md) e [skills instaladas](docs/SKILLS.md).

## Limites da entrega

Esta é a fundação do painel e da API. Ainda faltam parceiro de pagamentos e custódia, cadastro e verificação de clientes, checkout hospedado/tokenização real, autenticação humana com MFA, assinaturas dos planos, conciliação externa, estornos, chargebacks, saques reais, operação e revisão independente. O modo de produção é recusado pelo inicializador. O banco e o segredo locais devem ser protegidos pelo sistema operacional; esta versão não cifra o arquivo SQLite.
