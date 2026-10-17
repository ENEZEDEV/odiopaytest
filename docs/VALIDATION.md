# Validação executada

Data: 16 de outubro de 2026. Runtime: Node.js v24.19.0, Windows.

## Resultado

- `node --test`: **105 testes aprovados, 0 falhas, 0 ignorados**, incluindo leitor Mercado Pago, OAuth, cofre e criação de pagamentos com transporte controlado.
- `node scripts/demo.js`: Pix, cartão, liquidação, saldo e saque aprovados, todos simulados.
- Nenhum serviço de pagamentos externo foi utilizado e nenhum dinheiro real foi movimentado.

## Cenários cobertos

- OAuth: PKCE, state único, expiração, isolamento de loja/sessão, callbacks concorrentes e resultados antigos após nova tentativa ou desconexão.
- Tokens: cifragem autenticada, adulteração, chave errada, troca de contexto, refresh concorrente, recebedor divergente e expiração.
- Checkout de teste: Pix/cartão, comissão decimal exata, credencial do lojista, chave idempotente, campos injetados, resposta produtiva e envio incerto sem retentativa automática.
- Integração local entre OAuth cifrado e adaptador de pagamento, incluindo bloqueio após desconexão.

- Leitor Mercado Pago: recebedor, ID, referência, valor, moeda e método divergentes; respostas de produção; estorno parcial e estados não finais.
- Erros HTTP, indisponibilidade, timeout antes dos headers e durante o corpo, JSON inválido e resposta excessiva.
- Recusa de credencial produtiva e IDs que poderiam alterar a URL; token e dados de pagador não retornados.
- Esses testes não homologam o Mercado Pago. A consulta conectada e os saques pelo parceiro ainda não foram executados.

- Sessão do painel com cookie HttpOnly e SameSite=Strict, revogação no logout e ausência de API keys no frontend.
- Origem, CSRF, leitura cross-site e cabeçalho Host adulterado.
- Isolamento entre lojas nas ações de simulação.
- Fluxo do painel para cartão, confirmação, liquidação e saque com falha.
- Navegador: entrada na demo, criação Pix de R$ 125,50, simulação de pagamento, rejeição de saque de R$ 2.000 acima do saldo, reserva de R$ 50 e devolução por falha simulada.

- Criação e confirmação Pix/cartão com lançamentos que somam zero.
- Repetição de criação; conflito quando a mesma chave recebe outro conteúdo.
- Isolamento entre lojistas em consulta e listagem.
- Valores negativos, zero, abaixo do mínimo, fracionários, strings e acima do limite.
- Injeção de tarifa, plano, status, lojista e dados de cartão no corpo.
- Moeda e método inválidos; token ausente ou indevido.
- Arredondamento de tarifa e preservação da tarifa original após mudança de plano.
- Confirmação sem estado confirmado no simulador.
- Adulteração de valor, moeda, método, lojista e referência do parceiro.
- Repetição de evento e troca do ID para tentar duplicar lançamentos.
- Pagamento recusado e tentativa de alterar estado final.
- Falhas injetadas durante a contabilização e criação, com rollback verificado.
- Chaves armazenadas com hash, revogação e ausência de token nos registros.
- Autenticação HTTP, origem externa, JSON inválido, corpo grande e tipo de conteúdo.
- HMAC falso, corpo adulterado e timestamps antigos/futuros.
- Limite por IP, tentativa de contorno com X-Forwarded-For e limite de memória.
- Sanitização de erros internos e logs.
- Bloqueio de inicialização em produção, sem segredo e com porta inválida.
- Reabertura do banco preservando idempotência e deduplicação.
- Vinte criações HTTP simultâneas com a mesma chave: uma cobrança.
- Vinte confirmações HTTP simultâneas: um conjunto de lançamentos.
- Oito workers com conexões SQLite independentes: uma cobrança persistente.
- Disponibilidade somente após liquidação, com tarifa descontada e crédito idempotente.
- Reserva de saque, sucesso, falha definitiva e preservação de saldo total.
- Conflito na idempotência de saque, saldo insuficiente e adulteração de campos.
- Destino de outro lojista ou revogado; isolamento HTTP de carteira e saque.
- Falhas injetadas na liquidação, reserva e finalização, com rollback.
- Bloqueio de alterações e exclusões no diário pelo SQL normal.
- Oito saques com conexões independentes consumindo o saldo inteiro: um aceito e sete rejeitados; reserva preservada após reabrir o banco.
- Timeout rejeitado como estado terminal, mantendo a reserva até confirmação.

## Falha encontrada e corrigida

A primeira execução encontrou um placeholder extra no INSERT de pagamentos. O comando foi corrigido com a lista explícita das 11 colunas e os 11 parâmetros. A suíte completa e a demonstração foram executadas novamente com sucesso.

## Interpretação

Os testes verificam o comportamento atual nos cenários descritos. Não avaliam infraestrutura de produção, resistência a carga prolongada, segurança de um parceiro real, fluxos ainda não implementados ou conformidade regulatória. Não existe promessa de código sem falhas.
