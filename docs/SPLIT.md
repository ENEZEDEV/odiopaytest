# Primeira versão: split 1:1 com Mercado Pago

Decisão do responsável em 16/10/2026: priorizar menor necessidade de capital inicial e lançar com split. Esta decisão substitui a exigência anterior de carteira própria com saque integrado desde o lançamento.

## Fluxo do produto

1. O lojista cria seu cadastro ODIOPAY e conecta sua conta Mercado Pago por OAuth.
2. A ODIOPAY emite uma chave própria para o servidor do site do lojista criar e consultar cobranças. A chave deve ter isolamento, permissões e revogação.
3. O servidor identifica o lojista e usa a conexão autorizada correspondente; nunca aceita escolher outra conta financeira pelo corpo da requisição.
4. O checkout do parceiro processa o pagamento. O split separa a comissão da ODIOPAY da parcela do vendedor.
5. O painel acompanha as vendas processadas pela ODIOPAY, suas tarifas e estados conciliados. Não apresenta o saldo total da conta Mercado Pago como se estivesse custodiado na ODIOPAY.
6. Recebimento, disponibilidade e retirada de recursos seguem a conta e as regras do Mercado Pago. Saques pela ODIOPAY não fazem parte da primeira versão.

A escolha atual é Checkout Transparente via Payments API, OAuth e `application_fee`, com Pix e cartão. O responsável informou que a aplicação ODIOPAY para Checkout API foi criada. Faltam contas de teste, ambiente HTTPS e homologação. Orders não é adotada para split 1:1 sem demonstração documentada da cobrança equivalente de comissão.

## Receita e custos

Cobrar comissão fixa ou percentual configurada no servidor, convertendo-a no valor monetário aceito pela integração. No Checkout Pro, a documentação usa `marketplace_fee`; no Checkout Transparente via Payments, usa `application_fee`. Não definir uma porcentagem em campo que espera um valor em reais.

As tarifas atuais do simulador não representam a tarifa do Mercado Pago. Precisamos separar custo do processador e comissão da ODIOPAY e apresentar o total ao lojista. Confirmar preços, elegibilidade e eventuais condições comerciais antes de prometer uma operação sem mensalidade. Hospedagem, domínio, suporte e manutenção também exigem orçamento. A comissão não é garantia de lucro nem de receita irreversível: devoluções e contestações precisam de tratamento.

## Próximas entregas

| Entrega | Aceite |
| --- | --- |
| Aplicação e contas de teste | Aplicação criada; produto e contas elegíveis; redirect URI HTTPS definida |
| Conectar Mercado Pago | OAuth com state de uso único, vínculo ao lojista, proteção de tokens, expiração, renovação e desconexão testados |
| Chaves da ODIOPAY | Emissão, hash, permissões, revogação e isolamento entre lojas |
| Criar checkout com comissão | Intenção persistente, worker e identificação estável; nenhum crédito duplicado após timeout/reinício |
| Receber e conferir eventos | Assinatura oficial, inbox persistente, consulta ao parceiro e validação dos vínculos e valores |
| Painel coerente com split | Conectar conta, acompanhar vendas e comissões; carteira simulada identificada como demonstração |
| Homologar e liberar piloto | Fluxos de teste, devoluções, credencial revogada, falhas e reconciliação comprovados; custos e responsabilidades definidos |

O leitor e os novos serviços de OAuth/criação de pagamentos são componentes de teste, sem exposição nas rotas públicas e sem homologação externa. A criação usa `application_fee`; o split efetivo ainda precisa ser comprovado nas contas de teste. Veja [implementação e pendências](OAUTH.md). Não remover o bloqueio de produção para contornar essas pendências.

## Fontes oficiais

- [Integração de split e comissão](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace).
- [Pré-requisitos e autorização dos vendedores](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/prerequisites).

O plano anterior de carteira e Payouts em LAUNCH.md fica como referência de evolução futura, sem bloquear o lançamento com split.
