# Base de desenvolvimento e critérios de entrega

## Entrega atual

Monólito modular em JavaScript/Node.js 24, frontend nativo, SQLite e simulador local. O painel dark tem identidade e créditos NZ DEV. O código possui separação entre transporte HTTP, autenticação, regras de pagamento, carteira e persistência.

Execute `npm run check` antes de cada commit: verifica sintaxe de todos os módulos, executa os testes e percorre o fluxo financeiro simulado. O workflow usa o mesmo comando em Windows e Linux, sem segredos de pagamentos, com permissão de leitura e actions fixadas por commit. A existência do workflow não comprova uma execução bem-sucedida no GitHub; confira a aba Actions.

Não versionar bancos, credenciais, logs nem dados de clientes. Testes criam dados fictícios. Alterações financeiras devem manter testes de isolamento, idempotência, concorrência, rollback e conservação dos valores.

## Próximos marcos verificáveis

Escopo vigente: [split 1:1 Mercado Pago](SPLIT.md). Carteira e saques reais na tabela são evolução futura, fora da primeira versão.

| Marco | Critério de conclusão | Dependência |
| --- | --- | --- |
| Identidade humana | Cadastro, login, MFA, recuperação e revogação testados; sessões reais separadas da demonstração | Escolha de provedor de identidade e fluxos do produto |
| Persistência de produção | Migrações versionadas, isolamento de lojistas, concorrência e restauração comprovados | Ambiente PostgreSQL e requisitos de carga |
| Integração financeira | Contrato do adaptador, checkout tokenizado e webhooks autenticados testados no sandbox do parceiro | Parceiro e credenciais do seu sandbox |
| Processamento resiliente | Outbox transacional, tentativas idempotentes, tratamento de timeout e reconciliação de divergências | Contratos de eventos do parceiro |
| Carteira e saques reais | Titularidade do destino, autorização reforçada, limites, reconciliação e falhas simuladas | Definição operacional da custódia e do parceiro |
| Operação | Alertas, auditoria externa, backups/restauração, teste de carga, revisão independente e procedimento de incidentes | Infraestrutura e responsáveis definidos |

Esses itens são pendências, não recursos implementados. Não ligar o simulador a dinheiro real nem apenas remover o bloqueio de produção para publicar o produto.

## Uso de skills

Aplicar `security-best-practices` ao JavaScript do frontend e backend; não há referência específica nessa skill para HTTP nativo do Node. Usar `web-design-guidelines` nas revisões de interface e `supabase-postgres-best-practices` antes de desenhar a futura migração PostgreSQL. Skills React/Next só se aplicam se esses frameworks forem adotados. Instalar uma skill não executa uma auditoria nem substitui testes.

O próximo passo financeiro depende da escolha do parceiro: não inventar endpoints, regras de custódia ou contratos. O desenvolvimento local e os testes podem continuar sem credenciais reais.
