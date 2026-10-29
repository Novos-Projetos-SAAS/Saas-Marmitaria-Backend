# Candidata à implantação — InfinitePay

Referência: `CODEX_PACOTE_COMPLETO.md`, 1.430 linhas, SHA-256 `AE2B1EEA9D5424A08A9B2D36090C14FDF2A75BB1407DC1C43C0E4D6691FC9D08`. Fechamento funcional de 29/10/2026, exclusivamente nas branches `feature/infinitepay-checkout`.

## Resultado e limites

**NO-GO comercial.** A candidata preserva os bloqueios de ativação. Não foram executados deploy, migrations reais, concessões de permissão, pagamentos, `/links`, `/payment_check`, impressão ou alterações em H1/H2/H3/H4/DEMO.

A contagem usa as **18 RB** do PRD §4, sem somar repetições do TRD/UI/guia: **17 implementadas e verificáveis no ambiente sintético; RB-14 parcialmente implementada**, dependente do contrato externo de estorno. Das **6 HU**, 01–05 têm implementação funcional; HU-06 fica parcial pelo mesmo contrato. Isso não representa aceite de segurança ou homologação de infraestrutura comercial.

| Referência original | Situação funcional |
|---|---|
| RB-01–03; HU-01–03 | Empresa única; configuração cifrada; Pix/Crédito remotos sob gates; Dinheiro/Débito e todos os presenciais preservados. |
| RB-04–07; HU-02/04/06 | Reserva durável; confirmação independente; IDs e valor conferidos; concorrência/timeout não criam segunda cobrança. |
| RB-08–11 | Validade no dia de São Paulo; centavos/itens calculados no servidor; opções e cliente conforme especificação, sem descontos. |
| RB-12; HU-05; UI §6/7; Plano Etapa 4 | Comprovante por pedido no acompanhamento titular, sucesso, listagem e detalhe administrativo; telefone não autoriza recibo. |
| RB-13/15/16; App Flow §7 | Estados separados; mutações financeiras legadas bloqueadas; liberação persistente/outbox única/consumidor durável/lista e Socket existentes. |
| RB-14; HU-06; T24 | Motor sintético conserva produção e auditoria de estorno. Parser operacional ainda não tem prova independente homologada de estorno; **incompleto externamente**. |
| RB-17/18 | Segredo só no servidor; controles permanecem desligados até aceite e autorização. |

## Correções deste fechamento

- Acompanhamento protegido pelo cookie titular e associação persistida por pedido, inclusive histórico; pedido online atual pendente não recebe timeline de preparo. Recibo nunca vem da consulta pública por telefone.
- Comprovante no detalhe administrativo. Conciliação de INCERTA/DIVERGENTE só com permissão expressa, HTTPS/Origin/CSRF e UUID idempotente; apenas agenda eventos existentes para o verificador. Falta de identificadores continua bloqueada.
- Reinício explícito do orçamento de processamento de evento esgotado conserva estado/contador/erro anteriores em auditoria atômica. Nunca reinicia uma cobrança nem altera PAGA manualmente.
- Composição do autorizador, controle, diagnóstico e consumidor operacional no servidor, sem grants, flags ou workers automáticos. Controle disponível mesmo enquanto se aguarda nova aprovação após boot.
- Logout normal preservado. Sessão com histórico de grant financeiro exige CSRF e encerramento durável antes de limpar cookie, inclusive se a permissão foi removida; falha conserva a sessão no Frontend. Retry pode reparar a auditoria sem reativar a sessão. JWT já expirado/inválido só tem seu cookie inutilizável removido.
- Remover a credencial atual mantém a criação bloqueada, mas permite iniciar verificação histórica com grant WORKER/VERIFY específico e envelope preservado da tentativa. Isso não concede entrega nem criação com chave antiga.
- Lint corrigido sem supressões, CSS ou mudança de preços; carregamentos obsoletos cancelados e formulários reinicializados pela identidade dos dados.
- Cota de checkout por sessão viva validada no PostgreSQL: o IP compartilhado do BFF não esgota a cota de todos os compradores. Tokens inventados continuam na cota por IP; o limite geral permanece. Parser administrativo limitado a 8KiB antes do parser compartilhado.

## Cozinha e entrega lógica

O destino `admin-orders:<INFINITEPAY_DATABASE_ID>` é a **lista operacional persistida no PostgreSQL já existente**. O adaptador confere outbox, pedido, liberação e prova financeira; emite `novo_pedido_recebido` na sala `pedidos` do Socket.IO existente. O Frontend refaz a consulta ao conectar/reconectar.

O recibo `available:…` comprova a disponibilidade desse pedido na lista, e não recebimento pelo navegador ou impressão. Socket indisponível não elimina pedido nem liberação. O ledger durável impede reemitir a mesma entrega já reconhecida. Reimpressão continua ação manual, sujeita à autorização operacional já existente. Nenhuma alteração QZ/PEM/certificado foi feita. O gate que recusa ativação com impressão automática não certificada permanece.

## Matriz T01–T28

APROVADO significa integração **sintética** nesta candidata. Pix e Crédito reais já homologados pelo proprietário não foram repetidos. A matriz não transforma mocks em contrato externo nem certifica impressão física.

| ID | Resultado | Evidência permanente principal |
|---|---|---|
| T01 | APROVADO | FE `tests/browser/checkout.e2e.mjs`: jornada Pix com aplicações/adaptadores/worker/outbox. |
| T02 | APROVADO | Mesma jornada Crédito, incluindo encargo separado do valor original. |
| T03 | APROVADO | Navegador Dinheiro e BE `infinitepayConfig.test.js`: troco, itens, evento imediato. |
| T04 | APROVADO | Mesmos testes, variante Débito sem checkout. |
| T05 | APROVADO | PDV no navegador e POST administrativo dos quatro métodos. |
| T06 | APROVADO | Navegador: reload, fechamento/reabertura, cookies e recuperação sem React Context. |
| T07 | APROVADO | BE `infinitepayHttp.test.js` e navegador: prova independente sem retorno do cliente. |
| T08 | APROVADO | BE `phase6Resilience.test.js`: retorno HTTP processado antes de webhook, convergência/uma outbox. |
| T09 | APROVADO | HTTP/navegador: webhooks duplicados, única liberação e entrega lógica. |
| T10 | APROVADO | BE `infinitepayEvents.test.js`: eventos fora de ordem não rebaixam prova paga. |
| T11 | APROVADO | Orquestrador/HTTP/navegador: timeout mantém INCERTA sem outro despacho. |
| T12 | APROVADO | POST concorrente com mesmo UUID: uma reserva/pedido/tentativa. |
| T13 | APROVADO | Duas abas e requisições simultâneas; PostgreSQL impede dupla cobrança. |
| T14 | APROVADO | Eventos: divergência de valor/IDs bloqueia preparo e registra exceção. |
| T15 | APROVADO | HTTP/eventos: consulta indisponível preserva pendência e segredo. |
| T16 | APROVADO | Orquestrador/HTTP/eventos: expiração no dia, retomada bloqueada, pagamento tardio preservado. |
| T17 | APROVADO | Orquestrador recusa despacho após corte do dia; timezone complementado por unidades. |
| T18 | APROVADO | `phase6Resilience.test.js` e `productionHistoricalVerification.test.js`: rotação/remoção atual, reboot e check com snapshot/grant histórico; entrega continua exigindo autorização própria. |
| T19 | APROVADO | Backend titular/admin e navegador acompanhamento/detalhe/recibo. |
| T20 | APROVADO | Histórico misto, migrations, CRUD e ausência de recibo inventado. |
| T21 | APROVADO | GET telefone de pedido pago omite recibo/tokens/IDs; cookie de estranho recusado. |
| T22 | APROVADO | Socket.IO real sintético, reconexão do navegador, reinício do consumidor e lista persistente. |
| T23 | BLOQUEADO | Preservação lógica após erro simulada; falha/recuperação QZ operacional e impressão física não executadas por restrição. |
| T24 | BLOQUEADO | Núcleo de estorno sintético testado; falta contrato/prova externa para parser operacional. |
| T25 | APROVADO | Cancel/edit/delete com cobrança ativa recusados; conciliação administrativa não marca pago. |
| T26 | APROVADO | POST público adulterado não escolhe fluxo/preço/estado financeiro; sem fallback de reserva para offline. |
| T27 | APROVADO | JSON/limites/campos inesperados/canonicalização e logs sanitizados. |
| T28 | APROVADO | Autorização atual do banco, CSRF/Origin, conciliação/grants sem bypass admin. |

**26 APROVADOS, 2 BLOQUEADOS, 0 NÃO EXECUTADOS no recorte classificado.** O componente físico de T23 não foi executado; está incluído no bloqueio, não em aprovação parcial oculta.

## Verificação final e rastreabilidade

| Verificação na candidata | Comando | Resultado final |
|---|---|---|
| Backend, PostgreSQL descartável | `npm test` | **1.099/1.099**, 28 suítes, 0 falhas/skips; 535,8 s. |
| Frontend, unidades/contratos | `npm test` | **68/68**, 0 falhas/skips. |
| Navegador, HTTPS localhost sintético | `npm run test:browser` | **17/17**, 0 falhas/skips; 149,4 s. |
| Build Frontend | `npm run build` | Exit 0; compilação e geração de páginas concluídas. |
| Lint Frontend | `npm run lint -- --max-warnings=0` | Exit 0; **0 erros e 0 avisos**, sem supressões. |
| Diff/segredos novos | `git diff --check` e revisão dos arquivos adicionados | Sem erros de whitespace; nenhum padrão novo de chave privada, API Key ou token real detectado. |

Ambiente de verificação: Windows, Node 24.18.0, npm 11.16.0, PostgreSQL 18.4; Next 16.3.0 e React 19.2.4 coincidem com o lockfile. Nenhuma dependência foi adicionada. TLS, contas, chaves, provedores e receptores foram sintéticos. O banco foi criado exclusivamente para esta regressão, com schemas aleatórios `iptest_*`; não se reutilizaram H1/H4/DEMO. Logs, screenshots e material TLS de teste ficam fora do Git. O certificado sintético não altera certificados QZ.

As primeiras execuções expuseram interferência entre fixtures criptográficos, espera incorreta de hidratação do campo mascarado e a cota compartilhada do BFF; foram corrigidas antes das execuções finais acima. Testes focais adicionais validaram o parser 8KiB, consulta histórica na composição production e logout após perda de permissão/auditoria falha. Não se contabilizaram execuções falhas como aprovadas.

Base BE: `9d1f5a18c21720b331a206129cdb86eb59b22971`. Base FE: `18ecd0e79a6d5e7df12545ccc425e1d37d8b88d5`. Commit FE deste fechamento: **`cbeb56988983bc0cc811c9d35c30516de0c7f5a8`**. O commit BE contém este documento; obter seu SHA com `git rev-parse HEAD` após o fechamento. Ambos permanecem exclusivamente na branch autorizada, sem push/merge/deploy. Nenhuma migration, tabela ou funcionalidade existente foi removida.

Arquivos principais: `src/infinitepayServerComposition.js`, `src/services/operationalSocketDestination.js`, `src/services/administrativePaymentReconciliation.js`, controles/serviços existentes e seis testes de integração novos no BE; acompanhamento, modal/aba financeira, logout, loaders e cinco testes de contratos novos no FE. O diff de cada commit contém o inventário integral; os 37 arquivos FE incluem as correções de lint dos hooks/formulários, sem CSS ou regras de preços.

## Checklist executável da janela futura

Esta lista é instrução para uma janela **posteriormente autorizada**, não autorização para executá-la. Interromper em qualquer divergência.

### Perfil e infraestrutura

- [ ] Fixar SHAs revisados BE/FE e responsável de banco, proxy, conciliação, segredos e retorno de aplicação. Resolver os bloqueios abaixo antes de GO.
- [ ] BE: `NODE_ENV=production`, `INFINITEPAY_MODE=production`, `INFINITEPAY_DATABASE_NAME`, UUID estável `INFINITEPAY_DATABASE_ID`; conexão protegida `DATABASE_URL` ou `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`. Host remoto exige TLS com validação; `DB_SSL_CA` quando necessário. Declarar porta explicitamente.
- [ ] BE: `JWT_SECRET` forte (32–8192 caracteres); `INFINITEPAY_ENCRYPTION_KEY` ou keyring `INFINITEPAY_ENCRYPTION_KEYS`, `INFINITEPAY_ENCRYPTION_KEY_VERSION`. Guardar todas as versões históricas e backup das chaves separado do banco. Não há env `INFINITEPAY_API_KEY` no runtime: cadastrar via configuração administrativa dedicada, cifrada no banco.
- [ ] BE: `INFINITEPAY_PUBLIC_ORIGIN`, `INFINITEPAY_SUCCESS_URL` terminando exatamente em `/pedido/sucesso`, `INFINITEPAY_ALLOWED_PUBLIC_ORIGINS`, `ALLOWED_ORIGINS`, `INFINITEPAY_TRUSTED_PROXY_IPS`. HTTPS definitivo e origens exatas, sem túnel temporário/curingas. Proxy de um salto sobrescreve Host/X-Forwarded-Proto/X-Forwarded-For; backend inacessível diretamente.
- [ ] FE: `CHECKOUT_SITE_ORIGIN`, `CHECKOUT_BACKEND_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` coerentes no build. Nenhum segredo em `NEXT_PUBLIC_*`; DEMO ausente. Política QZ permanece separada, sem ativação implícita.
- [ ] Iniciar com `config_infinitepay.ativo=false` e `INFINITEPAY_CHECKOUT_ENABLED`, `INFINITEPAY_WORKER_ENABLED`, `INFINITEPAY_VERIFY_ENABLED`, `INFINITEPAY_DELIVERY_ENABLED` todos `false`.

Validar apenas o perfil carregado em cofre, sem imprimir valores nem abrir banco:

```powershell
node --input-type=module -e "import {validateProductionEnvironment} from './src/config/infinitepayProduction.js'; validateProductionEnvironment(process.env); console.log('Perfil válido; valores omitidos.');"
if ($LASTEXITCODE -ne 0) { throw 'Perfil inválido; interromper.' }
```

### Banco, backup e migrations

- [ ] Com leitura autorizada, conferir `current_database()`, `current_schema()`, `knex_migrations`, identidade única `infinitepay_identidade_ambiente` e mapeamento aprovado Pix1/Dinheiro2/Crédito3/Débito4. Runtime usa códigos/tipos, não IDs. A identidade inicial NAO_CONFIGURADO exige vinculação própria autorizada, não um UUID novo a cada boot.
- [ ] Inventário local: **39 migrations, nenhuma nova neste fechamento**. Quantidade pendente no alvo: **desconhecida** até consultar o ledger autorizado. Revisar lote exato e efeitos antes de `migrate:latest`; nunca seeds gerais nem rollback destrutivo.
- [ ] Atenção: `20261022000400_infinitepay_permissoes.js` contém grants históricos a admins ativos. Não reescrever esse histórico nem aplicar o lote silenciosamente. Aprovar explicitamente o efeito no alvo ou definir operação incremental própria autorizada. `pagamentos.ativar_producao` é criada sem atribuição; permissões finais dependem de decisão expressa.
- [ ] Backup completo restrito/cifrado, checksum, custódia separada das chaves, retenção e RPO/RTO definidos. Restaurar primeiro em banco vazio isolado, sem `--clean` e sem worker/criação. Comparar pedidos/itens, valores, ciphertext, FKs, tentativas, eventos, outbox, acesso, revogações e ledger de entregas.

Com serviços PostgreSQL e `PGPASSFILE` previamente configurados fora do Git, preencher variáveis privadas do operador:

```powershell
& (Join-Path $phase6PgBin 'pg_dump.exe') --dbname "service=$phase6PgServiceOrigem" --format=custom --file $phase6Backup
if ($LASTEXITCODE -ne 0) { throw 'Backup falhou.' }
Get-FileHash -LiteralPath $phase6Backup -Algorithm SHA256
& (Join-Path $phase6PgBin 'pg_restore.exe') --dbname "service=$phase6PgServiceRestore" --exit-on-error $phase6Backup
if ($LASTEXITCODE -ne 0) { throw 'Restore falhou.' }
# Somente com perfil apontando explicitamente ao clone restaurado:
node ./node_modules/knex/bin/cli.js migrate:list --env production
if ($LASTEXITCODE -ne 0) { throw 'Inventário falhou.' }
```

Aplicação real do lote depende de autorização da janela depois do ensaio no clone. Nunca operar clone e origem comercialmente ao mesmo tempo.

### Sequência operacional

- [ ] Implantar **Backend primeiro**, com flags desligadas. Conferir identidade/proxy, `prepared=true`, `running=false`, auth, pedidos offline/PDV e relatório. Nenhuma inicialização executa migrations.
- [ ] Implantar Frontend compatível. Cookie admin `token` HttpOnly/Secure; cookies BFF `__Host-marmitaria-checkout` e `__Host-marmitaria-status` HttpOnly/Secure/Lax/Path=/ sem Domain. Conferir CORS credenciado e domínio real. Escrita BFF exige Origin + `X-Checkout-CSRF`; controles financeiros usam `X-Infinitepay-CSRF`.
- [ ] Controle montado apenas no perfil production: `/pagamentos/controle-producao`. `GET /csrf` obtém CSRF sem conceder grant; `GET /` e `/diagnostico` exigem sessão/Origin/CSRF e permissão expressa `pagamentos.ativar_producao`, sem bypass pelo cargo.
- [ ] Aprovações `POST /approvals` separam WORKER/VERIFY_PAYMENT/DELIVER_ORDER/CREATE_LINK. Destino de entrega exato `admin-orders:<UUID da implantação>`. Não renovar automaticamente: padrão 300s, máximo 900s e limite do JWT. Definir política supervisionada e responsável para expiração/reboot antes de operação comercial. Cada processo/boot exige grant próprio.
- [ ] Worker: `POST /worker/start` e `/worker/stop`, JSON `{}`, sessão/Origin/CSRF. Start requer flags e grants preexistentes e não liga checkout. Boot aguarda aprovação sem derrubar a API. Reinício não ressuscita aprovações.
- [ ] Recuperação lógica explícita: `POST /entregas/:id/recuperar` sob o prefixo do controle, JSON `{}`, sessão/Origin/CSRF, worker e grant DELIVER_ORDER do destino já ativos. Só consulta/verifica recibo da entrega existente e reconhece a mesma outbox, mesmo esgotada; não reenvia, reduz contadores nem altera financeiro. Lease ativo ou recibo ausente mantém bloqueio. Verificar resultado e conservar auditoria.
- [ ] Logout sensível usa bootstrap restrito `GET /session/logout-csrf`, vinculado ao próprio JWT e permissão atual ou histórico financeiro da própria sessão. Não depende de conservar permissão financeira para sair; não permite criar grant ou ativar capacidades. `GET /csrf` administrativo continua exigindo permissão atual.
- [ ] Callbacks HTTPS: `POST /pagamentos/infinitepay/webhook` JSON e `GET /pagamentos/infinitepay/retorno`. Conferir método/roteamento/persistência/nonce no ingresso definitivo. HTTP200 reconhece persistência/duplicidade, não pagamento. Confirmação continua via check independente.
- [ ] Alertar INCERTA envelhecida, DIVERGENTE, eventos sem identificação/ERRO, outbox atrasada/esgotada, entrega INCERTA, worker sem ciclos, grant expirado/auditPending/diagnóstico503. Diagnóstico agrega contagens e idade mínima de INCERTA, sem IDs financeiros/URLs/segredos. Instalar supervisor externo; erro de observação não é zero saudável.
- [ ] Conciliação: `POST /pagamentos/admin/:id/conciliar`, `{request_id:UUID}`, permissão expressa `pagamentos.conciliar`, HTTPS/Origin/CSRF; apenas agenda verificação de eventos existentes. Guardar o mesmo UUID se a resposta se perder; sem IDs não inventar consulta.
- [ ] Depois de remover a credencial atual, supervisor pode aprovar WORKER/VERIFY para o ID histórico preservado. Criação fica bloqueada. Entrega continua dependente de configuração/credencial atual válida e aprovação de destino; uma aprovação histórica de verificação não autoriza cozinha por si.
- [ ] Habilitar somente na janela aprovada: worker/verificação/entrega supervisionados primeiro; configuração ativa e criação **por último**, depois do aceite de relatórios, segurança e operação. Não desligar impressão existente para contornar gate de segurança.

### Kill switch e rollback

- [ ] Para parar só novas cobranças, usar configuração autenticada `ativo=false`; o lock de despacho impede novos envios após confirmação. Persistir flag de criação false no próximo perfil. Conservar runtime/webhook, credenciais antigas e verificação/entrega autorizadas de cobranças existentes.
- [ ] Parada total `POST /emergency-stop` persiste geração e revoga capacidades; não desfaz HTTP já iniciado. `POST /recovery` requer geração atual e confirmação `RECUPERAR SEM ATIVAR CAPACIDADES`; não ressuscita grants.
- [ ] Rollback de binário: congelar criação, drenar worker, manter DB/schema/eventos/outbox/chaves, voltar apenas a versão compatível; se necessário manter BE financeiro enquanto reverte FE. Nunca `migrate:rollback`, excluir reservas ou restaurar snapshot antigo sobre eventos novos.
- [ ] Desastre: backup+WAL/estratégia de RPO aprovada em destino isolado; conciliar intervalo perdido com provedor antes de retomar. Nenhum rollback Git cancela cobrança; INCERTA não autoriza novo `/links`.

## Bloqueios restantes e responsáveis

| Natureza | Bloqueio / ação concreta |
|---|---|
| Segurança, crítico | [Plano QZ/PEM existente](PLANO_SEGURANCA_QZ_PEM.md): exposição histórica, custódia/identidade e assinador operacional continuam sem aceite suficiente. Nenhum novo protótipo ou impressão neste fechamento. |
| Contrato externo | Autenticidade/replay e entrega/retry completo de webhook; IDs suficientes sem browser; idempotência/recuperação após timeout de criação; prova independente de estorno/liquidação/repasse. Não foram inventadas garantias. |
| Operação/infraestrutura | HTTPS/proxy definitivo, firewall, supervisor/alertas, custódia, backup/restauração real/RPO/RTO e política de continuidade das aprovações ainda exigem execução/aceite. |
| Proprietário | Autorizar inventário/lote real de migrations e grants, implantação, habilitação comercial e ensaio operacional final. Nenhuma dessas autorizações decorre dos testes. |

O [guia oficial atual](https://ajuda.infinitepay.io/pt-BR/articles/10766888-como-usar-o-checkout-integrado-da-infinitepay) documenta API Key, opções, eventos e check; a [documentação interativa](https://www.infinitepay.io/checkout-documentacao) mantém exemplos com handle e webhook_url. Os contratos observados de Pix/Crédito foram preservados. A existência de nomes de eventos não comprova seu payload, autenticidade ou prova independente; a ausência desses detalhes nas páginas consultadas em 29/10 não prova inexistência no provedor.

Próximo passo: fechar estes bloqueios com evidência/decisão do responsável e autorizar uma janela concreta de implantação/ensaio. Não é necessária outra sequência de protótipos para as funcionalidades já verificadas.
