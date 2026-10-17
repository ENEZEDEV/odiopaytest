# ODIOPAY

- Operação inicial brasileira, BRL, Pix e cartão. Esta entrega é exclusivamente sandbox.
- Decisão atual de lançamento: split 1:1 Mercado Pago, contas de vendedores conectadas por OAuth e chaves próprias da ODIOPAY por lojista. Carteira própria e saques pela ODIOPAY ficam fora da primeira versão; a carteira existente é apenas simulação. Veja docs/SPLIT.md.
- Explique decisões e evidências de teste em português.
- Dinheiro em centavos inteiros; percentuais em basis points; nunca calcular dinheiro com ponto flutuante.
- Todas as consultas de lojista devem aplicar o merchant_id obtido da autenticação.
- Nunca receber, persistir ou registrar PAN, CVV, senhas ou credenciais em logs.
- Cartão usa token do parceiro. A confirmação depende de verificação no servidor.
- Criação de cobrança e eventos devem ser idempotentes e transacionais.
- Mudanças financeiras exigem testes de autorização, repetição, concorrência e invariantes monetárias.
- Execute `node --test` e `node scripts/demo.js` antes de entregar alterações no núcleo.
- Não habilite produção, repasses ou carteira sem implementar e verificar o respectivo fluxo.
- Evite abstrações sem uso, duplicação de regras e dependências desnecessárias.
- Ao concluir cada atualização, executar as verificações pertinentes, criar um commit descritivo e enviar ao origin. Se a autenticação impedir o envio, informar claramente o commit local e a pendência. Nunca declarar push concluído sem verificar o remoto.
- Preservar o histórico remoto; não usar force push. Nunca versionar credenciais, bancos de demonstração ou dados pessoais.
