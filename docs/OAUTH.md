# OAuth e Checkout Transparente: base de homologação

## Implementado e testado localmente

- `src/mp-oauth.js`: autorização com state aleatório vinculado ao lojista e à sessão, PKCE S256 e redirect HTTPS estático. State persistente, com expiração e uso único; callbacks antigos não substituem uma nova conexão nem desfazem uma desconexão.
- `src/token-vault.js`: AES-256-GCM da biblioteca criptográfica do Node, nonce aleatório e autenticação do contexto (aplicação, lojista, finalidade e ambiente). Tokens e verificador PKCE ficam cifrados no banco.
- Renovação com exclusão entre chamadas, validação do mesmo recebedor e troca do par de tokens. Resposta incerta exige reconexão. Crash durante refresh deixa a conexão bloqueada em `refreshing`; a recuperação atual é iniciar nova autorização, sem repetir cegamente o Refresh Token.
- Desconexão local invalida operações OAuth em andamento e remove tokens locais. Ainda não revoga o consentimento no Mercado Pago.
- `src/mp-marketplace.js`: adaptador de teste para `POST /v1/payments`, comissão em `application_fee`, credencial do vendedor conectado e chave estável de idempotência. Pix e cartão tokenizado em uma parcela. Não libera saldo nem contabiliza comissão.
- Transporte com recusa de redirecionamento, limites de resposta/tempo e erros sanitizados.

São serviços internos, sem rotas HTTP públicas ou botão de conexão no painel. A aplicação Mercado Pago foi criada segundo o responsável, mas ainda não foi conectada por este projeto. Não houve chamada autenticada real, pagamento ou homologação externa.

## Uso pelo servidor

O serviço OAuth recebe o banco aberto por `openDatabase`, `clientId`, `clientSecret`, `redirectUri` e `encryptionKey` (Buffer de exatamente 32 bytes). Gerar a chave aleatoriamente e mantê-la em armazenamento de segredos separado do banco. Reiniciar com outra chave impede a leitura dos tokens. Rotação com versões de chave e recuperação operacional ainda precisam ser implementadas para produção.

`begin(merchantId, sessionBinding)` deve receber o lojista da identidade autenticada e uma vinculação de sessão confiável; retorna apenas a URL de autorização. `complete` recebe o mesmo vínculo e código/state do callback. Nunca obter merchantId da query string. Não registrar códigos, state, tokens ou segredos em logs. Homologar a preservação/validação da sessão junto da política de cookies e do redirecionamento externo.

`status` retorna metadados sem tokens. `withConnection` é capacidade interna do servidor: não conectar seu retorno diretamente a uma resposta HTTP. O frontend usa apenas a chave pública adequada à tokenização.

O adaptador de pagamentos recebe intenção confiável (ID local, chave idempotente, valor, comissão e método) separada dos dados de checkout. Os valores devem vir do pedido/configuração persistidos pelo servidor. A validação estrita dos campos não substitui essa origem confiável.

## Pendências antes da API pública

1. Identidade humana real e sessão autenticada antes de vincular contas financeiras.
2. HTTPS público, callback cadastrado exatamente na aplicação e PKCE habilitado no painel.
3. Intenção persistente, outbox, worker e reconciliação. O adaptador não mantém idempotência local sozinho e não deve ser ligado diretamente à rota pública. Resposta incerta após POST pode corresponder a pagamento criado; consultar/reconciliar antes de repetir.
4. Checkout com MercadoPago.js, tokenização, dados adicionais do meio de pagamento e desafios de autenticação. Nenhum PAN/CVV deve passar pela API ODIOPAY.
5. Webhooks oficiais com inbox persistente, assinatura e tratamento de repetição/eventos fora de ordem.
6. Conferência das taxas e comissão efetivamente processadas, reembolsos e contestações. A resposta de criação não comprova recebimento da comissão.
7. Homologação com vendedor/comprador de teste e evidências do split. Prefixo `TEST-` e `live_mode: false` são bloqueios conservadores desta entrega; confirmar compatibilidade com o fluxo de teste escolhido.

Ainda não há domínio/hospedagem. Definir ambiente HTTPS de homologação e depois cadastrar o callback. Criar/configurar contas de teste no painel. Não copiar segredos para chat ou Git. O inicializador atual continua local e não configura esses serviços automaticamente.

## Fontes

- [Authorization Code e PKCE](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation).
- [Renovação de tokens](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/renewal).
- [Marketplace e application_fee](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/how-tos/integrate-marketplace).
- [Limites de equivalência com Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders).
