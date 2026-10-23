# Relatório técnico — Fase 1.3

Data: 23/10/2026, America/Sao_Paulo.

**A01 corrigido por política forward-only nas quatro migrations InfinitePay. Suíte completa: 111/111 testes aprovados, sem falhas, skips ou cancelamentos. Recomenda-se o encerramento técnico da preparação da Fase 1, mantendo a integração desativada.** Não houve alteração ou acesso ao sistema de produção, push, merge, deploy ou início da Fase 2.

## Escopo e controle

| Item | Evidência |
|---|---|
| Repositório | Somente Saas-Marmitaria-Backend |
| Branch | `feature/infinitepay-checkout`, já existente |
| Base desta fase | `d585db06c8a566d4b1d9e040e6e052bc9cd937cf` |
| Main de comparação | `492c3442ce047b1dc8353d24c237087ea2da85d4`; main local/origin e leitura remota de `refs/heads/main` conferidas |
| Mudança de produção nesta fase | Somente os quatro métodos `down` autorizados |
| Métodos `up` | Prefixos integrais anteriores ao down preservados byte a byte; quatro hashes SHA-256 idênticos |
| Migrations históricas da main | Nenhuma alterada |
| Novo schema / migration / executor | Nenhum criado; Knex oficial mantido |
| QZ/PEM, impressão e Frontend | Nenhum arquivo funcional modificado; nenhum teste contra estações ou impressão de produção |
| Integração InfinitePay | Desativada; `.env.example` mantém `INFINITEPAY_CHECKOUT_ENABLED=false`; configuração de teste continua `ativo=false` |

O SHA do novo commit e os diffs são registrados no relatório exportado após o commit, evitando autorreferência no arquivo versionado.

## Correção A01

Os caminhos destrutivos existentes nos down001–003 foram identificados e informados antes da edição. Nenhum deles foi executado contra banco nesta fase. O down004 anterior não bloqueava a operação e também foi corrigido.

| Migration / linha | Comportamento atual |
|---|---|
| `20261022000100_infinitepay_metodos_pedidos.js:19` | Recusa incondicional, inclusive em defaults intocados, classificação sem código, timestamp, UUID/hash e escrita concorrente. |
| `20261022000200_infinitepay_config_credenciais.js:36` | Recusa sem consultar ou remover configuração, credenciais ou relacionamentos. |
| `20261022000300_infinitepay_pagamentos_eventos_acessos_outbox.js:88` | Recusa sem consultar ou remover pagamentos, eventos, acessos ou outbox. |
| `20261022000400_infinitepay_permissoes.js:10` | Recusa explícita; não remove permissões/grants nem permite apagar silenciosamente o registro da migration. |

Todos executam imediatamente:

```js
throw new Error('Rollback bloqueado (forward-only): os dados e a estrutura existentes devem ser preservados. Use uma migration aditiva de correção.');
```

Não há consulta, lock ou operação de schema/DML dentro desses métodos. A falha independe de uso prévio, existência de dados ou possibilidade de consultar o banco. Não foi criado guard condicional, adaptador ou executor alternativo. Futuras correções estruturais devem ser aditivas e depender de autorização própria.

A autorização da Fase 1.3 substitui a alternativa pendente da Fase 1.2 para A01: a solução escolhida é a recusa incondicional nos quatro down. Os documentos anteriores permanecem como registro histórico daquela entrega, não como o estado atual de A01.

## Testes e evidências

Ambiente: Node 24.18.0, npm 11.16.0, Knex 3.2.9 e PostgreSQL 18.4 descartável, acessível somente por loopback na porta 55439. Banco de teste `infinitepay_phase1_test`, schemas aleatórios e dados exclusivamente sintéticos. O runner oficial do projeto é `npm.cmd test`, com isolamento por processo desativado e concorrência 1.

O usuário autorizou expressamente **somente a preparação e limpeza do PostgreSQL descartável** após a identificação do `DROP SCHEMA … CASCADE` no helper existente e das transformações históricas usadas para montar fixtures. Essa exceção não se aplica à produção ou a ambiente compartilhado. Inclui a preparação do diagnóstico sintético de hash órfão; a constraint é manipulada apenas nessa fixture para reproduzir o estado danificado anterior. Nenhuma operação de preparação/limpeza foi adicionada aos up ou down da integração.

| Execução | Resultado efetivamente observado | Evidência em outputs |
|---|---|---|
| Novo contrato antes do ajuste, sem banco | 4 falhas esperadas: três tentativas de acesso à dependência e uma ausência de recusa | `FASE_1_3_RED_SEM_BANCO.txt` |
| Novo contrato após ajuste, sem banco | 4/4 aprovados; nenhuma interação com a dependência de banco | `FASE_1_3_GREEN_SEM_BANCO.txt` |
| Executor oficial Knex + preservação estrutural | 7/7 aprovados, exit 0; 3.204,2604ms | `FASE_1_3_KNEX_TESTES.txt` |
| Diagnósticos A01 retomados | 11/11 aprovados, exit 0; 8.641,5266ms | `FASE_1_3_A01_TESTES.txt` |
| Suíte completa final | **111 testes, 111 aprovados, 0 falhas, 0 skips, 0 cancelados, exit 0; 20.768,2472ms** | `FASE_1_3_TESTES.txt` |

Os runs direcionados estão incluídos na suíte completa e não devem ser somados ao total 111. As mensagens de migration falhada nos logs dos testes negativos são a recusa esperada e verificada; não representam falhas ignoradas do runner.

### Executor oficial e histórico

`tests/integration/infinitepayKnexForwardOnly.test.js:61` verifica cada `db.migrate.down({name})`. As linhas 66 e 69 verificam `migrate.rollback()` e `migrate.rollback({}, true)`. Não se trata de um executor simulado.

Para cada tentativa, são comparados antes/depois tabelas, colunas, constraints, índices e todas as linhas, incluindo `knex_migrations` e `knex_migrations_lock`. Não há SQL de remoção no trecho monitorado; os registros de migration ficam aplicados, o lock retorna a 0 e `migrate.latest()` não reaplica nada. O Knex pode gerenciar transação e lock de controle, mas o down não executa SQL e não há efeito persistente parcial no estado comparado.

A fonte instalada do Knex 3.2.9 aguarda a conclusão do down antes de excluir seu registro de histórico; a rejeição percorre o tratamento de erro/liberação do lock. A revisão independente confirmou essa compatibilidade, sem necessidade de solução alternativa.

### Diagnósticos anteriores e regressão

`tests/integration/infinitepayRollback.test.js:35` cobre fluxo InfinitePay, liberação de cozinha, UUID/hash, código estável e os quatro tipos financeiros sem código. A linha 49 retoma o hash órfão preparado em schema sintético; a linha 63 confirma bloqueio mesmo sem uso; a linha 74 verifica a recusa com writer concorrente aberto e preservação de seu commit.

A antiga expectativa de permitir rollback sem uso foi deliberadamente substituída por recusa, conforme a política autorizada. O teste concorrente também passou de “esperar lock e inspecionar” para “recusar enquanto o writer está aberto”, sem prejudicar sua gravação. Não há teste pendente ou skip de A01 nesta entrega.

Os 89 casos anteriores foram reexecutados e passaram. Em `infinitepayConstraints.test.js`, somente as expectativas de rollback/removal incompatíveis com a política nova e a mensagem esperada foram atualizadas; as asserções de histórico, valores, IDs, concorrência e regras de negócio foram mantidas. Continuam aprovados Dinheiro/Débito remotos, quatro métodos presenciais, pedidos administrativos, troco, retirada, itens, eventos imediatos de cozinha, permissões, criptografia, sanitização e impressão habilitada no cadastro sintético. Não houve alteração no fluxo de cozinha ou impressão real.

## Comprovação de preservação

1. **Up inalterado:** `FASE_1_3_UP_ANTES.json` e `FASE_1_3_UP_COMPARACAO.json` registram SHA-256 e igualdade dos quatro prefixos completos até o down, incluindo comentários, função up e SQL.
2. **Estrutura preexistente:** `infinitepayKnexForwardOnly.test.js:73` captura as tabelas da main, suas colunas/defaults, constraints e índices antes dos quatro up. Após a execução, verifica que cada objeto anterior continua com a mesma definição.
3. **Dados e referências:** o mesmo teste preserva cada linha/campo anterior, incluindo pedidos, itens, usuários, roles, permissões e grants sintéticos, IDs e valores. Novas permissões/configuração previstas nos up são permitidas sem substituir as anteriores.
4. **Histórico rico:** o teste já existente `infinitepayHistory.test.js` continua aprovado, com quatro pedidos/métodos em estados diversos, 12 itens de três origens, 12 composições e snapshots/catálogos completos. Os valores históricos não são recalculados por preços atuais.
5. **Rollback sem efeito parcial:** as seis tentativas do Knex comparam integralmente o estado tabular capturado, inclusive índices/constraints e histórico; o tripwire dos quatro down comprova recusa antes de qualquer interação com o banco.

O snapshot não é um inventário integral de todos os objetos PostgreSQL: não enumera funções, triggers e sequências. A garantia dos down decorre também de não conterem nenhuma operação de banco, e a definição dos up continua integralmente idêntica. A evidência é de código e banco sintético; não é alegação de inspeção de dados reais, que não foram consultados.

## Revisão obrigatória contra main

A base comparada é `492c3442ce047b1dc8353d24c237087ea2da85d4`, também retornada pela consulta somente leitura da main remota nesta fase. Não houve alteração de refs para obter essa informação.

- Nenhum arquivo existente na main foi removido.
- Nenhuma migration histórica da main foi modificada; os quatro arquivos InfinitePay são adições da branch em relação à main.
- Nas quatro migrations da integração não restam comandos de remoção de tabela/coluna, índice, FK, função, permissão ou registro. As ocorrências `onDelete('RESTRICT')` são declarações protetivas de FK, não execução de DELETE.
- Há comandos potencialmente destrutivos em migrations **históricas** da main, sobretudo seus down. Eles foram identificados, preservados e não executados. O up histórico `20260426135626_Alteracao_da_tabela_de_logs.js:11`, por exemplo, substitui uma FK durante a montagem da fixture; isso não é alteração nova desta fase e ocorreu apenas no ambiente sintético autorizado.
- A preparação/limpeza dos testes contém remoções limitadas às fixtures, conforme a exceção explícita. Elas não integram os quatro down e não autorizam operações equivalentes em produção.

A lista A/M/D completa contra main e o diff consolidado são fornecidos como artefatos próprios. Os arquivos compartilhados modificados nas Fases 1/1.2 continuam visíveis nesse consolidado; não devem ser atribuídos ao commit da Fase 1.3. A documentação QZ anterior pertence à Fase 1.2 e não foi modificada nesta fase.

## Arquivos desta fase

Modificados:

- `src/database/migrations/20261022000100_infinitepay_metodos_pedidos.js`;
- `src/database/migrations/20261022000200_infinitepay_config_credenciais.js`;
- `src/database/migrations/20261022000300_infinitepay_pagamentos_eventos_acessos_outbox.js`;
- `src/database/migrations/20261022000400_infinitepay_permissoes.js`;
- `tests/integration/infinitepayConstraints.test.js`.

Criados:

- `tests/unit/infinitepayForwardOnly.test.js`;
- `tests/integration/infinitepayKnexForwardOnly.test.js`;
- `tests/integration/infinitepayRollback.test.js` (retomada do rascunho diagnóstico preservado);
- `docs/infinitepay/FASE_1_3.md`.

Nenhum arquivo foi removido. Não houve dependência nova, migration nova, alteração de configuração do executor ou funcionalidade adicional.

## Parecer e limites operacionais

**A01 está resolvido no escopo autorizado e a preparação da Fase 1 está tecnicamente apta ao encerramento.** A revisão independente estática não encontrou defeitos críticos ou importantes; os 111 testes foram executados e conferidos pelo agente principal. O revisor não executou testes nem recebeu credenciais.

A proteção é específica das quatro migrations InfinitePay. Um rollback completo com elas aplicadas para na recusa antes de alcançar os down históricos. Isso não torna todos os down antigos forward-only, não impede um comando explicitamente direcionado a migration histórica nem bloqueia SQL manual de um administrador. Esses caminhos não foram alterados ou executados e não fazem parte da autorização atual.

A integração permanece desativada. Homologação externa InfinitePay, métodos reais/backfill e qualquer implantação continuam sujeitos às respectivas etapas e autorizações. QZ/PEM está expressamente fora deste projeto por decisão do usuário; foi preservado, sem novo plano ou correção nesta fase. Nenhum parecer aqui autoriza merge, push, deploy, migrations reais ou avanço à Fase 2.
