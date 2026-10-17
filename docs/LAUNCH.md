# Referência futura: carteira e saques integrados

**Plano anterior, substituído pela decisão de lançamento com split.** O escopo vigente está em [SPLIT.md](SPLIT.md). Custódia própria, BaaS e saques integrados não são requisitos da primeira versão. As etapas abaixo documentam uma possível evolução futura e não representam a escolha comercial atual.

Atualizado em 16/10/2026. Estado: preparação técnica; lançamento real bloqueado pelos critérios abaixo. Responsável pelo produto: NZ DEV.

## Requisito anterior

Antes da decisão por split, foi considerada a exigência de visualizar saldo e solicitar saque dentro da ODIOPAY desde o lançamento. Essa exigência foi retirada do escopo inicial pelo responsável. Uma eventual carteira futura dependerá de validar e contratar o arranjo adequado; o saldo local do simulador não comprova custódia real.

O Mercado Pago é candidato, pois o usuário já tem conta. Não presumir que a conta existente está habilitada para operar recursos de terceiros. A documentação de [Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/overview) descreve transferências por Pix e para contas externas. Isso demonstra uma capacidade técnica, não comprova a aprovação do modelo comercial da ODIOPAY. A [referência do BCB sobre instituições de pagamento](https://www.bcb.gov.br/estabilidadefinanceira/instituicaopagamento) deve orientar a validação profissional do arranjo; este documento não determina enquadramento regulatório.

## Plano e critérios de avanço

| Etapa | Entrega | Critério objetivo para avançar |
| --- | --- | --- |
| 1. Viabilidade da carteira | Confirmação do parceiro sobre recursos de terceiros, titularidade e saques | Respostas documentadas às perguntas abaixo e responsáveis definidos |
| 2. Homologação técnica | Aplicação de teste, checkout, webhooks e saques de teste | Cenários ponta a ponta com evidências do parceiro, sem dinheiro real |
| 3. Base operacional | Identidade/MFA, banco de produção, segredos, reconciliação e recuperação | Testes de isolamento e concorrência, restauração de backup e tratamento de incidentes comprovados |
| 4. Piloto restrito | Pequeno grupo aprovado, limites definidos e suporte ativo | Nenhuma divergência financeira sem explicação; alertas e bloqueio de novas operações exercitados |
| 5. Expansão | Aumentar limites e número de clientes gradualmente | Revisão de incidentes, fraude, estornos, margem e capacidade antes de cada aumento |

Não há uma data de lançamento defensável antes da aprovação da etapa 1. Não prometer ausência total de falhas. Os critérios de aceite exigem evidências e riscos conhecidos, não apenas contagem de testes.

## Perguntas para o Mercado Pago

Texto preparado para o responsável pelo projeto encaminhar ao atendimento/comercial; não foi enviado automaticamente:

> Estamos desenvolvendo a ODIOPAY no Brasil. Queremos atender negócios de terceiros com Pix e cartão, exibir saldo individual e permitir que cada cliente solicite saque na interface ODIOPAY. Precisamos confirmar se o Mercado Pago suporta e permite contratualmente esse modelo. Quem será titular dos recursos e das contas? Há subcontas ou outro mecanismo de segregação por cliente? Quem executa KYC/KYB e monitoramento? Nossa conta/aplicação pode usar Payouts em testes e produção? Há validação de titularidade do destino, limites, tarifas, reservas e bloqueios? Como consultar saldo liquidado, conciliar saídas, resolver timeouts e receber devoluções? Como tratar reembolsos, contestações e eventual saldo negativo? Precisamos da documentação e do processo de habilitação para esse arranjo.

Se a resposta não atender ao modelo, avaliar parceiro de infraestrutura financeira que ofereça contas e saques compatíveis; não contornar a limitação juntando recursos de clientes em uma conta comum por decisão apenas técnica.

## Desenho técnico alvo — ainda não implementado

1. Cliente autenticado e autorizado solicita cobrança; dados de cartão seguem ao checkout/tokenizador do parceiro.
2. Banco grava intenção e tarefa de envio na mesma transação. Um worker envia fora da transação, com chave estável e limite de tempo.
3. Webhook autenticado é persistido antes do aceite HTTP. Um worker consulta a API e verifica vínculo ao cliente, referência, valor, moeda e estado.
4. Confirmação e liquidação são eventos distintos. O livro financeiro registra valores bruto, taxas reais, reservas, líquido e ajustes sem sobrescrever o histórico.
5. Saque exige autenticação reforçada, titularidade do destino e reserva transacional. A execução usa identificadores idempotentes; resultado incerto mantém a reserva e vai para reconciliação.
6. Somente o resultado individual definitivo do parceiro finaliza a saída. Reembolsos, devoluções e chargebacks têm lançamentos próprios.

A API [Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/integration-configuration/money-transfers) diferencia aceite do lote e resultado das transações: HTTP 202 não significa que o saque foi concluído. O adaptador de produção precisará respeitar as exigências de assinatura do parceiro; exemplos de teste não são configuração de produção.

## Matriz de falhas e evidências

| Cenário | Tratamento necessário | Evidência atual |
| --- | --- | --- |
| Cobrança/saque repetido, disputa pelo mesmo saldo | Idempotência e reserva transacional | Testes locais existentes |
| Acesso a dados de outro lojista, CSRF | Escopo de lojista e proteção da sessão | Testes locais existentes |
| Valor/recebedor/referência/moeda divergentes | Recusar atualização financeira | Novo leitor MP: teste com respostas controladas |
| HTTP 401/403/404/429/500, rede ou timeout | Erro sanitizado; sem presumir sucesso/falha financeira | Novo leitor MP: teste com transporte controlado |
| Resposta grande, inválida ou redirecionamento | Limites e recusa | Novo leitor MP: teste com transporte controlado |
| Estorno parcial, chargeback ou estado desconhecido | Preservar estado para tratamento específico | Leitor preserva dados; contabilização real pendente |
| Webhook falso, duplicado ou fora de ordem do MP | Assinatura oficial, inbox durável e reconciliação | Pendente; testes HMAC atuais são apenas do simulador |
| Crash após envio e antes de gravar resposta | Recuperar pela mesma referência sem novo débito | Pendente: outbox, worker e teste de reinício |
| Payout aceito com transação rejeitada | Consultar resultado individual | Pendente de integração/homologação |
| Conta bloqueada, chave Pix errada ou saldo negativo | Bloquear saída, registrar e reconciliar | Pendente de regras e testes do parceiro |
| Roubo de sessão, recuperação de conta e fraude | MFA, revogação e autorização por operação | Identidade humana ainda pendente |
| Perda do banco ou infraestrutura | Restaurar backup e reconciliar com parceiro | Pendente em infraestrutura de homologação |

Nenhum teste nesta entrega atacou o Mercado Pago ou movimentou dinheiro. A suíte não cobre todas as falhas possíveis. Antes do piloto: revisão independente, teste de carga com meta definida, termos/privacidade e responsabilidades operacionais validados.

## Primeiro componente implementado

### Preparar a aplicação de teste

O responsável ainda não criou a aplicação. Acesse o painel pelo [guia oficial de criação](https://www.mercadopago.com.br/developers/pt/docs/payouts/create-application), entre com sua conta e crie uma aplicação para a ODIOPAY. Confira em Dados da integração / Testes a disponibilidade das credenciais e do produto Payouts. Se o produto não aparecer, confirme a habilitação com o suporte; não presuma que um token de checkout atende saques. Ainda não configurar produção nem compartilhar o Access Token.

O guia também apresenta um plugin oficial do Mercado Pago para Codex. Ele não foi encontrado no catálogo de plugins disponível nesta sessão e não foi instalado ou conectado. A criação manual pelo painel continua sendo uma opção oficial.

### Leitor de consulta

`src/mercadopago.js` é um leitor de pagamentos de teste, sem integração à carteira. Não cria cobrança nem saque. Consulta o endpoint oficial, confere os dados esperados e retorna apenas o necessário. Não recebe estado financeiro do navegador como prova. Aprovação nunca vira saldo disponível automaticamente.

O código restringe credenciais a `TEST-` e exige `live_mode: false`; é uma política conservadora desta entrega. Confirmar esses requisitos com as credenciais reais de teste selecionadas antes da homologação. O prefixo sozinho não prova isolamento de ambiente. Os valores esperados precisam vir do cadastro/pedido confiável do servidor; no utilitário abaixo são informados manualmente para diagnóstico.

Para validar uma cobrança já criada no ambiente de teste, crie `.env.mp-test` localmente (ignorado pelo Git), preenchendo:

```dotenv
MP_ENABLE_TEST_READ=yes
MP_TEST_ACCESS_TOKEN=
MP_TEST_PAYMENT_ID=
MP_EXPECTED_COLLECTOR_ID=
MP_EXPECTED_REFERENCE=
MP_EXPECTED_AMOUNT_CENTS=10000
MP_EXPECTED_METHOD=pix
```

Depois execute `node --env-file=.env.mp-test scripts/verify-mp-payment.js`. Esse comando faz uma consulta externa autenticada. Não envie o arquivo ou o token pelo chat. Não há teste conectado concluído ainda; faltam credencial de teste e pagamento de referência.

Documentação técnica consultada: [consulta de pagamento](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro-preferences/get-payment/get), [webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/additional-content/notifications/webhooks) e [produção de Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/go-to-production). O fluxo real e a versão do produto devem ser confirmados antes de implementar criação de cobranças.
