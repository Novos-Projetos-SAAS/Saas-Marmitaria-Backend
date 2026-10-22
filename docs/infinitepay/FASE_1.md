# InfinitePay — Fase 1 (preparação interna)

Implementa somente schema, configuração e segurança. Nenhuma API InfinitePay é chamada. Não há checkout, webhook, redirecionamento, serviço de aprovação, worker, outbox producer ou interface financeira. A criação de pedidos e a emissão à cozinha continuam no controller legado, sem alteração.

## Estado desativado

- INFINITEPAY_CHECKOUT_ENABLED=false no exemplo de ambiente; não existe consumidor que crie checkout nesta fase.
- config_infinitepay.ativo=false é imposto também pela constraint ip_config_phase1_disabled e pelo PUT.
- Nenhuma credencial real foi fornecida ou usada. Credenciais nos testes são sentinelas sintéticas.
- Campos financeiros externos são preparatórios; seu formato e semântica ainda dependem de homologação.
- Sem multitenancy; configuração única id=1.

## Migrations aditivas

1. 20261022000100_infinitepay_metodos_pedidos.js: codigo nullable, tipo_financeiro default OUTRO, fluxo_pagamento default POSTERIOR, timestamp de liberação nullable, UUID/hash de requisição. Não classifica métodos por nome ou IDs presumidos.
2. 20261022000200_infinitepay_config_credenciais.js: configuração única e credenciais cifradas/versionadas, contexto de conta, proibição de alteração de uma versão de credencial.
3. 20261022000300_infinitepay_pagamentos_eventos_acessos_outbox.js: tentativas, eventos, hashes de acesso e outbox. Bloqueio concorrente por pedido independente do status; uma liberação lógica de outbox por pedido.
4. 20261022000400_infinitepay_permissoes.js: permissões configurar/visualizar/conciliar e vínculo idempotente aos administradores ativos existentes.

Migrations históricas não foram editadas. Up/down das novas migrations foram testados somente em PostgreSQL local e dados sintéticos. Down recusa apagar registros financeiros/credenciais/classificações; não é procedimento de rollback em produção. A migration de permissões preserva registros e vínculos em down, pois podem preexistir. Rollback de deploy deve manter a estrutura e os dados.

credencial_id/handle_snapshot das tentativas são nullable no schema preparatório e formam um par com FK composta quando informados. Antes de criar qualquer checkout real na Fase 2, o serviço deverá exigir esse vínculo e snapshot. transaction_nsu/invoice_slug possuem índices de consulta, sem unicidade externa presumida. Não confundir snapshot/ID de evento com prova financeira.

Registros duplicados efetivamente pagos devem poder ser auditados, mesmo que o aplicativo proíba iniciar uma segunda cobrança. Por isso não há índice que impeça registrar um segundo fato financeiro PAGA; a liberação de cozinha é única em outra restrição.

## Contrato administrativo

GET /configuracoes/infinitepay e PUT /configuracoes/infinitepay:
JWT em cookie token; usuário e cargo atuais conferidos no banco; usuário/nível ativo e não excluído; pagamentos.configurar via RBAC existente (admin tem acesso amplo).

GET retorna status/data com handle, ativo=false, assured_installments e has_api_key. Retorna também csrf_token vinculado à sessão. Nunca devolve chave, fragmento, cifra, IV ou tag. Cache-Control: no-store e Referrer-Policy: no-referrer.

PUT exige Origin exatamente incluída em ALLOWED_ORIGINS, Content-Type application/json e header X-Infinitepay-CSRF recebido no GET da mesma sessão. A proteção rejeita origem ausente/null e token de outra sessão. A origem CORS não substitui RBAC/CSRF.

Campos permitidos: handle, api_key, remove_api_key, ativo (apenas false), assured_installments (inteiro 0–12).
- Omitir api_key mantém a versão corrente.
- api_key substitui a credencial por nova versão imutável.
- remove_api_key=true desconecta a configuração corrente e preserva versões históricas.
- Alterar handle com chave corrente exige substituição ou remoção explícita.
- Salvar não valida a conta no provedor e não ativa a integração.

## Cifra e rotação

AES-256-GCM com IV aleatório de 12 bytes, tag de 16 bytes e AAD incluindo a conta. INFINITEPAY_ENCRYPTION_KEY contém 32 bytes aleatórios em base64; gerar fora do Git. INFINITEPAY_ENCRYPTION_KEY_VERSION seleciona a versão de escrita.

INFINITEPAY_ENCRYPTION_KEYS pode conter um objeto JSON versão→chave base64 para conservar chaves de decriptação históricas. A versão da cifra é diferente do ID da credencial do provedor. Não remover uma chave de cifra enquanto houver versões que dependam dela; backups precisam de recuperação segura desse segredo. Uma API Key revogada na InfinitePay não passa a funcionar por estar guardada no banco.

O segredo em texto necessariamente existe brevemente na memória do servidor; não registrar, serializar ou encaminhar a observabilidade. JavaScript não permite garantir zeragem de todas as strings geridas pelo runtime.

## Logs e compatibilidade

O logger geral grava somente método, rota estática conhecida, usuário interno e status. Não grava URL completa, query, body, headers, stack, SQL ou erro bruto. Mensagens 5xx são genéricas. Conflitos estruturados de cardápio mantêm seus códigos e campos públicos necessários.

O cadastro da empresa rejeita campos desconhecidos, ignora id/timestamps reenviados pelo formulário legado e registra apenas nomes de campos alterados. Credenciais financeiras devem usar exclusivamente a rota dedicada. Contrato de impressora/cadastro válido preservado.

Dinheiro e débito remotos e os quatro métodos no PDV foram exercitados por HTTP com banco real de teste. Total, troco, status, persistência e evento novo_pedido_recebido foram verificados. Não houve mudança em Pedidos.Controller.js, pedidosUtils.js, rotas de pedidos, Qz.Controller.js, Qz.Routes.js ou Frontend.

## Testes isolados

Requisitos: Node 24+, PostgreSQL real descartável em loopback; nunca usar DATABASE_URL de produção. Instalação de dependências: npm ci --ignore-scripts.

Em PowerShell, depois de iniciar seu cluster de testes:
    $env:TEST_DATABASE_URL='postgresql://codex_test@127.0.0.1:55439/infinitepay_phase1_test'
    npm.cmd test

O nome deve seguir infinitepay_*test. A conexão de teste rejeita host remoto, nome de banco comum, parâmetros de query e não usa fallback de produção. Cada fixture cria um schema aleatório iptest_* e o remove ao terminar. Nenhuma seed é executada. Configuração NODE_ENV=test faz o aplicativo usar somente a URL explícita de testes.

O runner é o node:test nativo, sem isolamento em processos e com execução sequencial, para suportar o sandbox Windows. Testes incluem:
- schema vazio e histórico sintético com IDs não sequenciais;
- up/down e recusa de down com fatos financeiros;
- FK, checks, UUID/hash, dedupe e concorrência por conexões independentes;
- ciphertext aleatório, adulteração, AAD e rotação de chave;
- JWT, RBAC, usuário/cargo ativo, CSRF, CORS e escrita;
- falhas reais de banco e chave malformada, console/auditoria/resposta sem sentinelas;
- compatibilidade do PDV e pedidos remotos offline, loja fechada e alimento indisponível.

O teste negativo de rollback emite mensagem esperada do Knex sobre bloqueio: o teste passa porque recusar a destruição é o resultado exigido. Isso não é migration de produção executada.

## Métodos reais: atividade pendente e isolada

Não houve leitura de produção. A classificação automática permanece desabilitada; codigo fica NULL e tipo_financeiro OUTRO. O serviço applyVerifiedPaymentMethodMap recebe explicitamente conexão e mapa revisado (ID, nome esperado, código, tipo), valida todos os IDs e faz tudo em uma transação. Não é montado em rota nem executado no startup/migration.

As consultas em consultas_pre_backfill_somente_leitura.sql são apenas propostas. Somente após autorização de leitura no ambiente real será possível revisar o mapa. Não executar o backfill nessa ocasião; a aplicação do mapa exige sua própria janela autorizada. Nomes não são usados para inferir gateway em runtime.

## QZ e PEM: risco preservado para tratamento separado

private-key.pem já estava versionado na main e tem estrutura de chave privada sem marcador de criptografia. Não foi adicionado nem alterado nesta fase; .gitignore passa a evitar novos PEM, mas isso não remove o histórico nem revoga a chave existente.

O código ativo QZ lê QZ_PRIVATE_KEY do ambiente. Não foi comprovado que corresponde ao PEM rastreado. /qz/assinar permanece sem autenticação e assina material fornecido pelo chamador; seus logs de debug também merecem revisão. Não houve mudança nessa rota para não interromper a impressão existente.

Recomendações: identificar responsável/fingerprint por canal seguro; se estiver ativa, rotacionar e substituir certificado/chave com plano de continuidade; depois sanear repositório/histórico. Planejar autenticação/autorização e associação de impressão à comanda elegível em fase própria. Não prometer exclusão de segredo já distribuído.

## Gates antes da Fase 2

Aprovação específica do usuário; mapa real validado antes de uso; homologação de payloads/assinatura ou consulta confiável sem redirect; estratégia de timeout sem nova cobrança cega; confirmação dos IDs e URLs permitidos; regras de cancelamento/estorno e pagamentos tardios.

O schema preparatório não prova segurança do gateway. Fase 2, merge e deploy não foram autorizados por esta implementação.
