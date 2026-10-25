# Saas-Marmitaria

## Relatórios e dashboard financeiro

Os relatórios gerenciais e as vendas do dashboard usam a **criação do pedido em America/Sao_Paulo**. A quantidade de pedidos é operacional (inclui pendentes/cancelados); faturamento e ticket médio usam vendas consideradas. POSTERIOR preserva o cálculo legado, sem afirmar recebimento pela InfinitePay. Um pagamento online só entra com prova independente válida, valor original correspondente ao pedido, identificadores preenchidos e método confirmado. CRIANDO, AGUARDANDO, INCERTA e pagamentos sem prova não entram nas vendas.

A view `vw_rel_pedidos_financeiros` produz uma linha por pedido e escolhe a tentativa comprovada mais recente, ou a última tentativa quando não há prova. Eventos não são somados. PAGA e LIQUIDADA com prova entram pelo valor original; LIQUIDADA não afirma repasse bancário. ESTORNADA fica fora das vendas atuais. Cancelamento operacional não desfaz um pagamento comprovado; relatórios de itens/produção continuam excluindo cancelados.

O relatório **Pagamentos InfinitePay** permite escolher data do pedido, confirmação independente (`pago_em`) ou estorno comprovado (`estornado_em`), sempre em São Paulo. Mostra pendências, pedido, método escolhido e meio efetivamente confirmado. Pagamentos posteriormente estornados permanecem no histórico de confirmações. Taxas, valor efetivamente estornado e líquido recebido permanecem nulos: não são inferidos da diferença entre valor original e valor pago pelo comprador. O resumo financeiro do dashboard usa confirmação para pagamentos, estorno para devoluções e criação para pendências, com bases indicadas na tela.

O histórico mantém o valor original do pedido sem totalizá-lo como venda; a coluna de venda considerada tem total separado. PDF, impressão e Excel levam os critérios; valores monetários desconhecidos são “Não informado”, nunca zero inventado. A listagem de marmitas especiais e o limite de quatro especiais no dashboard são preservados.

A migration incremental `20261025000100_relatorios_financeiros.js` mantém as funções históricas, atualiza assinaturas compatíveis sem DROP, acrescenta um histórico estendido e preserva os IDs/filtros do catálogo. Rollback é bloqueado (forward-only). Não altera pedidos, itens, métodos, tentativas, eventos ou ativação do checkout. Aplicação fora do banco descartável exige planejamento e autorização de implantação.

Para regressão local, defina `TEST_DATABASE_URL` apontando exclusivamente para PostgreSQL loopback com banco `infinitepay_*test` descartável e execute `npm test`. A suíte cria e remove somente seus schemas sintéticos. Os testes de navegador, exportação e build ficam no Frontend. Não use o banco de homologação H1 nem produção.

