# A01 — estratégia quando a aplicação da migration é desconhecida

Fase 1.2, 23/10/2026. O responsável respondeu **“Não sei confirmar”** sobre aplicação da migration `20261022000100_infinitepay_metodos_pedidos.js` fora dos testes locais isolados. Conforme a condição expressa da autorização, esse arquivo não foi modificado. Não foi consultado banco real para resolver a dúvida.

## Diagnóstico confirmado

O down existente não verifica `liberado_cozinha_em`, `client_payload_hash` independentemente, nem `tipo_financeiro` diferente de OUTRO quando não há código. Além disso, verificar antes de obter lock permite uma gravação concorrente ser confirmada entre a inspeção e a remoção de colunas.

Onze testes de diagnóstico foram preparados e executados com dados sintéticos: quatro passaram, sete falharam como esperado contra a implementação original. As sete falhas demonstram timestamp, quatro classificações sem código, hash órfão de histórico danificado e corrida concorrente. Não foram convertidas em aprovação nem ocultadas em skips.

O rascunho integral dos testes foi preservado no artefato `FASE_1_2_A01_TESTES_PENDENTES.js.txt`, fora da suíte entregue, porque a correção está condicionada. Seu local de destino, quando retomado, é `tests/integration/infinitepayRollback.test.js`. O arquivo usa imports relativos desse destino e não deve ser executado diretamente de outputs. Evidências: `FASE_1_2_A01_RED.txt` e `FASE_1_2_SUITE_ANTES_A01.txt`.

## Contenção até a decisão

- Não executar o rollback da migration 001 em ambiente compartilhado ou produção com o mecanismo atual. Nenhum rollback real foi executado nesta fase.
- Preservar histórico e arquivo original; não presumir que ausência de push deste trabalho comprove ausência de aplicação manual anterior.
- Obter confirmação do operador responsável ou registro de execução de migrations por processo autorizado. Não coletar credenciais em mensagens. Qualquer leitura de banco real permanece sujeita a autorização específica, inexistente nesta fase.
- Manter a integração desativada. A01 é uma pendência de proteção de remoção do schema, não exige ativar serviço financeiro para ser resolvido.

## Alternativa 1 — comprovar aplicação somente local

Se for confirmado que a migration nunca foi aplicada fora dos testes isolados, a autorização atual permite corrigir seu down, sem alterar o up:

1. Abrir transação própria ou savepoint quando já houver transação do migrator.
2. Obter lock exclusivo de `pedidos` e `metodos_pagamento` antes da inspeção.
3. Recusar qualquer valor novo significativo: fluxo diferente de POSTERIOR, timestamp de liberação não nulo, UUID ou hash não nulo, código não nulo ou tipo financeiro diferente de OUTRO.
4. Fazer toda a remoção na mesma transação; permitir apenas defaults intocados e preservar integralmente os campos/itens legados.
5. Restaurar e executar os onze testes pendentes, incluindo concorrência; testar rollback/up pelo Knex e reexecutar a suíte inteira.

É o menor ajuste de código, mas a confirmação é obrigatória antes de editar o arquivo histórico.

## Alternativa 2 — preservar definitivamente a migration histórica

Se foi aplicada ou a dúvida não puder ser resolvida, recomenda-se desenho de execução **forward-only** nos ambientes existentes e uma proteção nova no executor de rollback, sem reescrever o arquivo 001:

- Criar um adapter de migrations/entrypoint controlado, integrado à configuração do Knex, que envolva o down da migration 001 com transação, locks e a inspeção completa descrita acima, antes de delegar ao down histórico.
- Manter nomes, ordem e conteúdo das migrations históricas e o comportamento de up. Verificar tanto o CLI oficial configurado quanto o uso programático: um script opcional que possa ser contornado por `knex migrate:rollback` não seria proteção suficiente.
- Documentar e restringir caminhos de execução direta do down histórico e permissões operacionais de DDL. O executor de aplicação não deve ganhar privilégios globais/superuser para resolver isso.
- Testar descoberta de migrations, batches antigos, aplicação em banco vazio e histórico, rollback sem uso, cada bloqueio, erro intermediário/atomicidade e gravação concorrente. Validar a versão instalada do Knex e as transações do adapter antes de escolhê-lo.
- Definir procedimento de recuperação por correção aditiva/forward em vez de remoção automática quando já houver dados financeiros. Não introduzir event trigger global nem alterar dados existentes por esse motivo.

Essa alternativa é uma **proposta a aprovar**, não código implementado nesta fase: amplia o executor de migrations e precisa de validação própria. Uma migration SQL aditiva sozinha não corrige a função JavaScript down antiga; não deve ser apresentada como solução automática para A01.

## Parecer

A01 permanece aberto. O histórico foi preservado e os caminhos não afetados foram concluídos. O encerramento definitivo da Fase 1 depende de confirmação para a alternativa 1 ou aprovação/implementação/testes de uma estratégia compatível como a alternativa 2. Este documento não autoriza migrations reais, deploy ou avanço à Fase 2.
