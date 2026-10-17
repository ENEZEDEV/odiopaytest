# Carteira e saques — decisão e implementação sandbox

Decisão confirmada pelo usuário: saldo dentro da experiência ODIOPAY e possibilidade de saque.

## Valores apresentados

| Campo | Significado |
| --- | --- |
| `receivableCents` | Pagamentos confirmados, líquidos de tarifa, ainda não liquidados pelo simulador |
| `availableCents` | Valor liquidado que pode ser reservado para um saque |
| `reservedCents` | Valor comprometido com solicitações de saque ainda sem resultado definitivo |
| `withdrawnCents` | Total histórico de saques concluídos no simulador; não compõe o saldo atual |

Pagamentos ainda pendentes não fazem parte desses valores. `receivableCents + availableCents + reservedCents` representa os valores atuais apresentados nesta versão; não inclui estornos ou contestações, ainda não implementados.

## Fluxo

1. Pagamento aprovado: registra valor líquido a receber.
2. Liquidação simulada explícita: move de a receber para disponível.
3. Pedido de saque autenticado: valida destino, valor e chave idempotente.
4. A mesma transação verifica disponibilidade, cria o saque e reserva o valor.
5. Sucesso confirmado pelo simulador: remove a reserva e registra valor sacado.
6. Falha definitiva: remove a reserva e devolve a disponibilidade.
7. Resultado desconhecido/timeout: preserva a reserva para reconciliação.

`wallet_journal` registra movimentos sem permitir alteração ou exclusão pelas operações SQL comuns. As tabelas `withdrawals` e `wallet_settlements` dão suporte à idempotência. Um administrador com controle total do banco ainda pode alterar schema e remover proteções; a versão de produção precisa de controles externos e trilha auditável independente.

Exemplo: uma cobrança Pix sandbox de R$ 100 com tarifa ilustrativa de R$ 1 gera R$ 99 a receber. Após liquidação, R$ 99 ficam disponíveis. Um saque de R$ 50 deixa R$ 49 disponíveis e R$ 50 reservados. Após sucesso, o saldo atual é R$ 49 e o total histórico sacado é R$ 50.

## Custódia real e próxima integração

O saldo exibido pelo software não resolve, por si só, a guarda jurídica e financeira dos recursos. O Banco Central descreve contas de pagamento como contas utilizadas para pagamentos e transferências e trata a prestação desses serviços no contexto das instituições de pagamento. A escolha de parceiro, estrutura contratual e responsabilidades precisa ser validada para o modelo da ODIOPAY antes de operar recursos reais.

Fontes oficiais consultadas em 16/10/2026: [contas de pagamento](https://www.bcb.gov.br/meubc/faqs/s/contas-de-pagamento) e [instituições de pagamento](https://www.bcb.gov.br/estabilidadefinanceira/instituicaopagamento). Este documento não define o enquadramento jurídico da ODIOPAY.

O adaptador real deverá confirmar liquidação e execução de saque no parceiro, usar idempotência também no parceiro, guardar resultados incertos para reconciliação e verificar a titularidade do destino. O controle local que simula crédito não poderá ser convertido em rota pública para alterar saldos.

O lançamento real também exige autorização reforçada do saque, prevenção de fraude, limites, política para chargebacks/estornos, definição de taxas de saque, monitoramento e recuperação. Essas funções não foram simuladas como se estivessem prontas.
