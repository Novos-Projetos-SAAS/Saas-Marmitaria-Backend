# Relatório técnico — Fase 1.2 InfinitePay

Data: 23/10/2026, America/Sao_Paulo.

**Resultado: A02 corrigido e testes complementares concluídos. A01 permanece aberto porque a aplicação da migration em ambiente compartilhado é desconhecida. A Fase 1 ainda não pode ser encerrada definitivamente.**

O usuário respondeu “Não sei confirmar” à pergunta sobre aplicação da migration 001 fora dos testes locais. A condição expressa da autorização exige essa confirmação antes de editar a migration. Por isso seu conteúdo foi preservado, sem presumir ausência de aplicação e sem consultar banco real. Foi preparada uma estratégia compatível com preservação de histórico.

## Controle e limites

| Item | Situação |
|---|---|
| Repositório | Somente Saas-Marmitaria-Backend |
| Branch | `feature/infinitepay-checkout`, já existente |
| Base da Fase 1.2 | `7501f73746ba3a909cffb33d0fdf2fb58abf2a32` |
| Alteração de código de produção | Apenas `src/utils/safeRequestLog.js` |
| Migrations criadas ou modificadas | Nenhuma; quatro migrations da Fase 1 preservadas |
| Banco usado | PostgreSQL 18.4 local descartável, loopback:55439, schemas aleatórios, somente dados sintéticos |
| Integração | Desativada; `INFINITEPAY_CHECKOUT_ENABLED=false` e configuração persistida `ativo=false` nos testes |
| Push / merge / deploy / banco real / backfill | Não realizados |
| Checkout / webhook / worker / redirect / Frontend | Não implementados ou modificados |
| PEM / assinatura QZ / pedidos / cozinha | Código e material existentes preservados |

O commit e seu diff são fornecidos junto ao relatório exportado; seu SHA é registrado após a criação do commit, sem autorreferência no documento versionado.

## A02 — corrigido

Em `src/utils/safeRequestLog.js:14`, o logger passa a preservar o `auditBase` atribuído pelos mounts estáticos do servidor, mesmo quando `req.route` ainda não existe. Depois da seleção da rota, conserva prefixo + template. Sem prefixo confiável e sem rota, continua `[unmatched]`. Nenhuma nova leitura de `originalUrl`, `path`, query, body ou headers foi introduzida.

Evidência: `tests/security/paymentLogRedaction.test.js:28` e `:40` cobrem pré/pós-rota e sentinelas; `:48` recusa baseUrl isolada como fallback pré-rota. Em `tests/integration/infinitepayConfig.test.js:101` e `:125`, falhas reais de consulta em tabelas temporariamente renomeadas no schema sintético confirmam resposta genérica, endpoint estático e ausência de segredos na auditoria/console.

Antes da correção, os casos unitário e HTTP pré-rota falharam por retornar `[unmatched]`. Após o ajuste, passaram. A validação não depende de mock do banco ou do errorHandler. Os mounts atuais atribuem literais conhecidos; a compatibilidade antiga com `baseUrl` quando existe rota permanece. Futuras montagens dinâmicas precisam respeitar a mesma regra de prefixo confiável.

## A01 — reproduzido, sem alteração do histórico

Evidência: `src/database/migrations/20261022000100_infinitepay_metodos_pedidos.js:20` e `:21` continuam originais. A inspeção do diff confirmou ausência de modificação nesse arquivo.

Foram preparados onze testes de rollback contra banco sintético. Quatro passaram: fluxo InfinitePay, UUID/hash válido, código estável e rollback dos defaults sem uso. Sete falharam, demonstrando as lacunas:

- timestamp de liberação de cozinha em pedido POSTERIOR;
- quatro tipos financeiros significativos sem código: PIX, CREDITO, DEBITO e DINHEIRO;
- hash órfão em cenário explicitamente danificado, com CHECK restaurado como NOT VALID;
- gravação concorrente confirmada entre a inspeção e a obtenção do lock necessário à remoção.

O último caso mantém uma transação escritora aberta e observa espera por lock através de `pg_blocking_pids`, em vez de presumir ordenação por tempo. Depois confirma o writer e exige bloqueio do rollback. O down atual termina removendo a informação; uma correção deverá bloquear antes de inspecionar e executar inspeção/DDL na mesma transação.

Os onze testes foram preservados em `FASE_1_2_A01_TESTES_PENDENTES.js.txt`, artefato externo ao glob da suíte entregue. Não estão marcados como aprovados ou silenciosamente ignorados. Quando a correção puder ser retomada, seu destino é `tests/integration/infinitepayRollback.test.js`; os imports do rascunho pressupõem esse destino.

Estratégia detalhada: [ESTRATEGIA_A01_HISTORICO_PRESERVADO.md](ESTRATEGIA_A01_HISTORICO_PRESERVADO.md).

Se for comprovada aplicação somente local, pode-se corrigir apenas o down conforme a autorização. Se aplicada ou desconhecida, preservar o arquivo, evitar rollback pelo mecanismo antigo e avaliar proteção nova no executor oficial de migrations, com transação, locks e guard completo. Um wrapper opcional contornável não resolve o risco. Essa mudança no executor exige escolha e validação próprias; não foi implementada automaticamente. Uma migration SQL aditiva não altera a função JavaScript histórica.

## Testes complementares entregues

| Área | Arquivo e evidência |
|---|---|
| Content-Type | `infinitepayConfig.test.js:82`: sessão/Origin/CSRF válidos com text/plain, form-urlencoded, octet-stream e Content-Type ausente retornam 415, sem alterar configuração, credenciais ou ações de auditoria. |
| Empresa e impressão | `infinitepayConfig.test.js:230`: cadastro existente com impressão true e impressora selecionada; GET→PUT do objeto completo; atualização de nome sem perder campos, ID/criação preservados e metadados enviados pelo cliente ignorados. Não imprime fisicamente. |
| Dinheiro/débito e PDV | `infinitepayConfig.test.js:262`: seis combinações legadas mantidas e asserções ampliadas; `:303` testa 401/403 sem pedido/evento; `:320` cobre retirada administrativa em dinheiro e débito, duas unidades, itens/composição, total 40, sem troco, evento imediato e nenhuma nova persistência financeira/outbox. |
| Integridade financeira | `infinitepayIntegrity.test.js`: 55 casos independentes para NSU e pedido/tentativa únicos, status/provedor/valores/tentativas, pares credencial/conta, FKs e exclusões RESTRICT, key version, nonce/access hash, validade, estados/tentativas/eventos, dedupe e liberação única da outbox por INSERT e UPDATE, UUID/hash e classificação. |
| Preservação histórica | `infinitepayHistory.test.js`: quatro pedidos e métodos ativos/renomeados/inativos/excluídos; 12 itens dos três tipos, 12 composições, snapshots e catálogos completos; todos os campos preexistentes e valores comparados antes/depois do up; nenhuma classificação inferida ou registro financeiro criado. |
| Segurança | Testes originais de criptografia autenticada, key ring, RBAC, CSRF, sanitização e integração desligada continuam na suíte. |

As expectativas de integridade verificam SQLSTATE e o nome da constraint alvo, além de snapshots dos dados após rejeição. Isso impede um erro de FK ou índice diferente de mascarar o caso que se pretende testar. Fixtures de credenciais estruturais são marcadas como sintéticas e não são chaves utilizáveis.

## Execuções e interpretação dos resultados

Runner: Node 24.18.0 / npm 11.16.0; `npm.cmd test` usa `node --test --test-isolation=none --test-concurrency=1 tests/**/*.test.js`. O alvo é exclusivamente `infinitepay_phase1_test` em loopback; a guarda de URL de teste permanece ativa.

| Execução | Resultado | Evidência em outputs |
|---|---|---|
| Reprodução A02 antes do fix | 20 casos: 18 passam, 2 falham pelo prefixo perdido | `FASE_1_2_A02_RED.txt` |
| A02 e regressões iniciais após fix | 21/21, sem falhas ou skips; antes dos três casos administrativos adicionais | `FASE_1_2_A02_GREEN.txt` |
| Integridade/histórico | 56/56 no run final direcionado | `FASE_1_2_SCHEMA_TESTES.txt` |
| A01 diagnóstico original | 11 casos: 4 passam, 7 falham; nenhum skip | `FASE_1_2_A01_RED.txt` |
| Ensaio completo com A01 ainda original | 100 casos: 93 passam, 7 falham, 0 skips; exit 1 | `FASE_1_2_SUITE_ANTES_A01.txt` |
| Suíte entregue, sem o rascunho A01 condicionado | 89/89, 0 falhas, 0 skips, 0 cancelados; exit 0; 11.494,4573 ms | `FASE_1_2_TESTES.txt` |

**Não se pode declarar “100 testes aprovados”.** A entrega tem 89 testes executáveis; os onze casos A01 são uma pendência demonstrada. As execuções da tabela se sobrepõem e não devem ser somadas como casos distintos.

A revisão independente final foi estática, sem executar a suíte novamente: não confirmou defeito novo bloqueante em A02, regressões ou plano QZ. Confirmou A01 aberto e a pertinência do teste concorrente. A execução dos testes e seus resultados acima foram conferidos pelo executor principal, sem atribuí-los ao revisor.

Na elaboração dos testes de integridade, seis expectativas iniciais de exclusão RESTRICT foram ajustadas: o PostgreSQL retorna 23001 nesse caminho, enquanto inserção com referência inexistente retorna 23503. A evidência conserva a falha inicial e a reexecução corrigida; nenhum código de produção mudou para acomodar o teste. Uma tentativa inicial de runner com subprocessos recebeu EPERM; a execução real usou a configuração sem isolamento por processo já adotada pelo projeto.

## Arquivos da entrega

Modificados:

- `src/utils/safeRequestLog.js`;
- `tests/security/paymentLogRedaction.test.js`;
- `tests/integration/infinitepayConfig.test.js`.

Criados:

- `tests/integration/infinitepayIntegrity.test.js`;
- `tests/integration/infinitepayHistory.test.js`;
- `docs/infinitepay/FASE_1_2.md`;
- `docs/infinitepay/PLANO_SEGURANCA_QZ_PEM.md`;
- `docs/infinitepay/ESTRATEGIA_A01_HISTORICO_PRESERVADO.md`.

Os relatórios, diffs, evidências e rascunho A01 externos ao repositório são artefatos de entrega, não mudanças de código implantadas. Nenhuma dependência nova, migration nova, seed ou backfill foi adicionada.

## Segurança QZ/PEM — plano, sem execução

Documento separado: [PLANO_SEGURANCA_QZ_PEM.md](PLANO_SEGURANCA_QZ_PEM.md).

Inclui contenção de distribuição/acesso, inventário seguro da identidade ativa, restrição de exposição coordenada com as estações, autenticação/autorização e proteção de escrita do assinador, remoção futura de logs brutos, rotação conjunta de certificado/chave e testes de continuidade. Não assume que o PEM rastreado seja a chave ativa. Nem o material privado nem a assinatura existente foram removidos ou alterados. O risco alto preexistente permanece até correção operacional autorizada.

## Riscos pendentes e parecer final

- **P2 A01 aberto:** guard incompleto e corrida no rollback. Histórico preservado devido à confirmação inconclusiva. Impede encerramento definitivo da Fase 1.
- **P1 QZ/PEM preexistente:** assinador aberto/material privado versionado; plano entregue, correção e impressão física não executadas.
- Sanitização dos demais emissores legados não foi ampliada para todo o Backend. A02 se refere ao logger compartilhado revisado.
- IDs reais, backfill, locks/volume e implantação de migrations reais continuam sem homologação. Nenhum acesso real foi feito.
- Contrato InfinitePay, webhook autenticado, identificação, idempotência e recuperação após timeout continuam dependentes do checklist da Fase 1.1. Nenhuma funcionalidade financeira externa foi presumida ou exercitada.
- Testes de hardware QZ, credenciais reais, banco compartilhado, volume real e Frontend continuam não executados. As configurações de produção não foram lidas.

**Pode-se aprovar A02 e a evidência das regressões entregues, mantendo a preparação desativada. Não se recomenda encerrar definitivamente a Fase 1 enquanto A01 não tiver uma solução autorizada e validada.** A correção QZ segue como atividade separada conforme o escopo solicitado. Não há autorização ou avanço automático para a Fase 2, publicação ou produção.
