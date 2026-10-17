# Segurança da entrega sandbox

## Escopo

Revisão e testes locais da versão 0.3. Não é um pentest independente, uma certificação ou uma garantia de ausência de falhas. Não foi realizado ataque contra sistemas externos.

## Controles implementados

| Risco | Controle | Código |
| --- | --- | --- |
| Leitura de cobrança de outro lojista | Consulta com ID e merchant_id autenticado; resposta 404 | `src/payments.js`, `src/security.js` |
| Cobrança repetida | Unicidade no banco e transação; comparação do conteúdo normalizado | `src/database.js`, `src/payments.js` |
| Alterar tarifa ou status pela API | Lista estrita de campos; cálculo no servidor | `src/validation.js`, `src/payments.js` |
| Forjar confirmação | HMAC do corpo bruto e timestamp; comparação resistente a diferença de tempo | `src/security.js` |
| Repetir webhook | Janela de assinatura e deduplicação persistente por evento/pagamento | `src/security.js`, `src/payments.js` |
| Confirmar sem pagamento | Conferência de valor, moeda, método e identidades; leitura independente do simulador | `src/payments.js` |
| Atualização parcial | Status, lançamentos, evento e auditoria na mesma transação | `src/payments.js`, `src/database.js` |
| Dados sensíveis em logs | Registro de código, status e ID de requisição; erro interno sanitizado | `src/http.js` |
| Injeção SQL | Consultas parametrizadas; IDs validados | `src/payments.js`, `src/security.js` |
| Abuso de volume | Limites de corpo, cabeçalhos, tempo e requisições por IP do socket | `src/http.js`, `src/security.js` |
| Sacar saldo ainda não liquidado | Disponibilidade depende de liquidação local explícita | `src/wallet.js` |
| Gastar o mesmo saldo duas vezes | Verificação e reserva na mesma transação de escrita | `src/wallet.js` |
| Desviar saque para outro lojista | Destino sandbox vinculado ao lojista autenticado | `src/wallet.js` |
| Devolver reserva após pagamento incerto | Timeout não finaliza saque; mantém reserva | `src/wallet.js` |

## Limites materiais

- O controle de resultados do simulador é confiável apenas no contexto local. Quem controla o processo ou arquivo do banco controla os dados.
- API keys são credenciais de servidor. O painel possui sessões de demonstração com expiração e logout, cookies HttpOnly/SameSite, validação de origem e CSRF. Ainda não há identidade humana real, MFA, recuperação ou interface de rotação/revogação de API keys. Revogação já é respeitada pela autenticação.
- Limites por IP são locais ao processo. Não são proteção suficiente contra DDoS distribuído e devem evoluir para limites por identidade e integração com a infraestrutura.
- Auditoria é uma tabela transacional local; não é um armazenamento imutável independente. Falhas de requisição são emitidas pelo logger, mas ainda não existe coleta central, alerta ou retenção operacional.
- O SQLite não é cifrado nesta entrega. O segredo do webhook é fornecido por ambiente. Proteção de arquivos, gestão de segredos, rotação e recuperação precisam ser implementadas para o ambiente real.
- A aplicação inicia no loopback e recusa modo de produção. A configuração de TLS, proxy e rede de uma implantação real ainda não foi feita.
- O schema de protótipo está na versão 3, com novas tabelas criadas sem apagar as anteriores; ainda não há infraestrutura de migrações para atualizações de produção. Os novos tokens OAuth são cifrados individualmente; o arquivo SQLite como um todo continua sem cifragem.
- O formato do webhook é próprio do simulador. Cada parceiro real exige verificação conforme sua documentação.
- Há liquidação, saldo e saque simulados. Ainda não há reconciliação externa, reembolsos, chargebacks, antifraude, verificação de titularidade, custódia ou execução de saques reais.
- A API sandbox de saque usa chave de lojista. Antes de saques reais, implementar autenticação humana reforçada, autorização da transação, limites de risco, controle de destinos e reconciliação com o parceiro.
- Planos e tarifas são dados de demonstração, sem cobrança de assinatura ou precificação validada.

## Fontes usadas na implementação

- [OWASP — integração de gateways de pagamento](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html): confirmação no servidor, correspondência de dados e idempotência.
- [OWASP — segurança de webhooks](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html): assinatura, prevenção de repetição e limites.
- [Node.js — SQLite](https://nodejs.org/api/sqlite.html): API de persistência usada no protótipo.

A skill `security-best-practices` foi consultada. O catálogo instalado não tem referência específica para o servidor HTTP nativo do Node; os controles foram implementados com base nas fontes acima e verificados pelos testes locais. A skill `security-threat-model` foi instalada para uso futuro; não foi produzido um relatório formal por essa skill nesta entrega.
