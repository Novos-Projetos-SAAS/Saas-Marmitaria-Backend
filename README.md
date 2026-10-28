# Saas-Marmitaria

## Relatórios e dashboard financeiro

Os relatórios gerenciais e as vendas do dashboard usam a **criação do pedido em America/Sao_Paulo**. A quantidade de pedidos é operacional (inclui pendentes/cancelados); faturamento e ticket médio usam vendas consideradas. POSTERIOR preserva o cálculo legado, sem afirmar recebimento pela InfinitePay. Um pagamento online só entra com prova independente válida, valor original correspondente ao pedido, identificadores preenchidos e método confirmado. CRIANDO, AGUARDANDO, INCERTA e pagamentos sem prova não entram nas vendas.

A view `vw_rel_pedidos_financeiros` produz uma linha por pedido e escolhe a tentativa comprovada mais recente, ou a última tentativa quando não há prova. Eventos não são somados. PAGA e LIQUIDADA com prova entram pelo valor original; LIQUIDADA não afirma repasse bancário. ESTORNADA fica fora das vendas atuais. Cancelamento operacional não desfaz um pagamento comprovado; relatórios de itens/produção continuam excluindo cancelados.

O relatório **Pagamentos InfinitePay** permite escolher data do pedido, confirmação independente (`pago_em`) ou estorno comprovado (`estornado_em`), sempre em São Paulo. Mostra pendências, pedido, método escolhido e meio efetivamente confirmado. Pagamentos posteriormente estornados permanecem no histórico de confirmações. Taxas, valor efetivamente estornado e líquido recebido permanecem nulos: não são inferidos da diferença entre valor original e valor pago pelo comprador. O resumo financeiro do dashboard usa confirmação para pagamentos, estorno para devoluções e criação para pendências, com bases indicadas na tela.

O histórico mantém o valor original do pedido sem totalizá-lo como venda; a coluna de venda considerada tem total separado. PDF, impressão e Excel levam os critérios; valores monetários desconhecidos são “Não informado”, nunca zero inventado. A listagem de marmitas especiais e o limite de quatro especiais no dashboard são preservados.

A migration incremental `20261025000100_relatorios_financeiros.js` mantém as funções históricas, atualiza assinaturas compatíveis sem DROP, acrescenta um histórico estendido e preserva os IDs/filtros do catálogo. Rollback é bloqueado (forward-only). Não altera pedidos, itens, métodos, tentativas, eventos ou ativação do checkout. Aplicação fora do banco descartável exige planejamento e autorização de implantação.

Para regressão local, defina `TEST_DATABASE_URL` apontando exclusivamente para PostgreSQL loopback com banco `infinitepay_*test` descartável e execute `npm test`. A suíte cria e remove somente seus schemas sintéticos. Os testes de navegador, exportação e build ficam no Frontend. Não use o banco de homologação H1 nem produção.

## Execução integrada em homologação

`src/server.js` instala os adaptadores observados de `/links`, `/payment_check` e webhook no runtime existente. O worker inicia depois do servidor HTTP e encerra seu processamento pendente antes do fechamento do banco. Importar `app.js` não inicia workers. O modo padrão é `disabled`; a criação também exige flag explícita e `config_infinitepay.ativo=true`.

Nesta etapa somente `INFINITEPAY_MODE=homologation` com `NODE_ENV=development` é permitido. O processo valida a conexão antes de carregar a aplicação: host loopback, nome declarado e, em seguida, identidade real do PostgreSQL. O banco H1 é recusado. Produção e `NODE_ENV=test` não são caminhos de ativação. Os testes automatizados do navegador usam schemas descartáveis e a mesma composição com ambiente development validado, sem o gate artificial `creationEnabled`.

Configuração do perfil privado de homologação, fora do Git:

| Variável | Requisito |
| --- | --- |
| `NODE_ENV` | `development` |
| `INFINITEPAY_MODE` | `homologation` (ausente/`disabled` mantém o runtime desligado) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL exclusivo e local, nunca produção/H1 |
| `DATABASE_URL` | Vazia no perfil completo quando se utilizam os campos `DB_*`; não herdar a URL de produção |
| `INFINITEPAY_DATABASE_NAME` | Nome exato do banco, iniciado por `infinitepay_` e terminado em `test` ou `homologacao` |
| `INFINITEPAY_CHECKOUT_ENABLED` | `false` inicialmente; só `true` após autorização e preflight |
| `INFINITEPAY_PUBLIC_ORIGIN` | Origem HTTPS real do backend, sem caminho/query/credenciais |
| `INFINITEPAY_SUCCESS_URL` | HTTPS real do Next.js com caminho `/pedido/sucesso` |
| `INFINITEPAY_ALLOWED_PUBLIC_ORIGINS` | Origens HTTPS permitidas explicitamente, separadas por vírgula |
| `ALLOWED_ORIGINS` | Inclui a origem do Next.js, para CORS e CSRF administrativo |
| `JWT_SECRET`, `INFINITEPAY_ENCRYPTION_KEY` ou `INFINITEPAY_ENCRYPTION_KEYS` | Segredos próprios da homologação; preservar versões antigas necessárias às credenciais pendentes |

O PostgreSQL descartável de regressão existente em `127.0.0.1:55439/infinitepay_phase1_test` serve apenas a dados sintéticos, sem API Key real. O banco `infinitepay_h1_homologacao`, porta 55440, não é usado por esta execução. Não reaproveite o banco descartável para cobranças reais.

Para iniciar o servidor normal use um perfil externo completo, por exemplo `node --env-file=<arquivo-privado-de-homologacao> src/server.js`. Não carregue um `.env` de produção. Inicie o Next.js com `NEXT_PUBLIC_API_URL` e `CHECKOUT_BACKEND_URL` apontando somente para esse backend; `CHECKOUT_SITE_ORIGIN` e `NEXT_PUBLIC_SITE_URL` devem corresponder à origem HTTPS da loja. Nunca coloque a API Key em variáveis `NEXT_PUBLIC_*`.

Na aba InfinitePay das configurações existentes, somente usuário ativo com `pagamentos.configurar` pode gravar, com Origin exata, CSRF da sessão e JSON. A chave digitada é enviada ao servidor e armazenada com AES-GCM; não é devolvida nem mantida em storage do navegador. O preflight de ativação exige worker ativo, flag habilitada, credencial decifrável, mapeamentos explícitos PIX/Crédito e impressão automática desligada. A configuração de banco começa desligada, inclusive após a nova migration.

A migration `20261025000200_infinitepay_ativacao_controlada.js` substitui exclusivamente o CHECK deliberado da Fase 1 por um CHECK que exige credencial e conta para `ativo=true`; ela não ativa a configuração. Acrescenta o recibo durável do consumidor isolado. O consumidor usa `infinitepay_entregas_homologacao.chave_unica` para não repetir seu efeito, sem emitir para Socket.IO, cozinha ou impressão. A administração consulta os pedidos liberados pelas rotas existentes. O consumidor operacional de produção continua sem autorização.

### Validação integrada e limites do contrato

O teste de navegador monta o pedido, salva a configuração autenticada, ativa apenas a fixture isolada, envia Pix/Crédito pelo fluxo normal, valida o JSON `{url}`, recebe webhooks repetidos, realiza `payment_check` independente e aguarda worker/outbox sem chamar processamento manual. Verifica comprovante, recuperação do pedido, uma entrega persistente e contabilização pela view financeira. A segunda confirmação acontece depois do desligamento de novas cobranças. As regressões existentes cobrem duplo clique, resposta perdida, reinício do navegador, INCERTA, falha de entrega, PDV, relatórios e exportações.

`POST /links` não é repetido após timeout ou resultado incerto. A reserva permanece bloqueada mesmo após reinício. HTTP 200 do webhook reconhece persistência, não pagamento. Assinatura/autenticidade do webhook e o ciclo de estorno/liquidação ainda exigem contrato oficial: o adaptador observado aceita created/paid/settled como sinais e só reconhece pagamento por prova independente. Não transforma `settled` em repasse bancário nem aceita campos inventados para confirmar estorno. Os cenários sintéticos de estorno comprovado e cancelamento continuam cobertos pela suíte financeira existente.

### Desligamento e monitoramento

Desative **novas cobranças** pela configuração administrativa, preservando o modo homologation e o worker. A operação sincroniza com envios já autorizados: o lock compartilhado permanece até o cliente HTTP terminar (timeout limitado); depois de a desativação retornar, nenhum envio pendente de autorização pode iniciar. Envios já iniciados podem ter criado links e devem ser conciliados. `stop()` bloqueia criação imediatamente, inclusive durante preflight, e aguarda o ciclo do worker. SIGINT/SIGTERM executam a rotina de encerramento no servidor; o teste de boot no Windows verifica inicialização, e o teste do runtime verifica drenagem do worker (não atribui encerramento gracioso a um encerramento forçado do Windows).

Não use `INFINITEPAY_MODE=disabled` nem remova versões criptográficas para um desligamento emergencial de criação: isso impediria a verificação de cobranças existentes. A flag de ambiente fica `false` no perfil do próximo início; o banco permanece `ativo=false`. Nunca apague tentativas INCERTA, eventos, chaves antigas ou a outbox para liberar outra cobrança.

Consultas operacionais somente de leitura, no ambiente autorizado:

```sql
SELECT status, count(*) FROM pagamentos GROUP BY status ORDER BY status;
SELECT status_processamento, ultimo_erro, count(*) FROM pagamentos_eventos
GROUP BY status_processamento, ultimo_erro ORDER BY status_processamento, ultimo_erro;
SELECT status, count(*), min(criado_em) AS mais_antigo
FROM outbox_eventos GROUP BY status ORDER BY status;
SELECT name, batch, migration_time FROM knex_migrations ORDER BY id;
```

Eventos/outbox com retentativas esgotadas permanecem registrados para conciliação autorizada; não são prova de falha da cobrança. O contador de erros do worker cobre falhas de execução, enquanto as consultas acima mostram falhas de negócio/verificação e filas bloqueadas. Não registrar payloads, URLs privadas, API Key ou identificadores completos em alertas.

### Homologação futura de Crédito

Não se presume que o Pix homologou Crédito. Proposta para autorização posterior: uma única compra de **R$ 1,00**, em **1x**, `assured_installments=1`, sem descontos, somente depois de a InfinitePay confirmar o mínimo aceito para Crédito nessa conta/Checkout. A documentação oficial consultada não estabelece esse mínimo: R$ 1,00 é proposta, não mínimo garantido nem autorização de transação. Se o mínimo for maior, apresentar novo valor para aprovação, sem tentativas exploratórias.

Com valor autorizado, usar um pedido sintético no ambiente persistente isolado e uma reserva exclusiva. Observar resposta de checkout, domínio HTTPS e payload real do webhook; pagar manualmente escolhendo crédito; conferir `transaction_nsu`, fatura e vínculo com o pedido antes de `payment_check`. Exigir `paid=true`, `amount` correspondente e `capture_method=credit_card`; registrar separadamente `paid_amount`, parcelas e comprovante. Não inferir taxas/líquido. Recusa/cancelamento só serão marcados como homologados quando efetivamente observados; cancelamento operacional não é estorno. Após timeout, não gerar outro link automaticamente.

Referências: [guia oficial atual](https://ajuda.infinitepay.io/pt-BR/articles/10766888-como-usar-o-checkout-integrado-da-infinitepay) e [documentação interativa](https://www.infinitepay.io/checkout-documentacao). `assured_installments` trata absorção de taxas, não garante um limite de parcelas oferecidas ao comprador.

### Procedimento de implantação (somente preparação; requer nova autorização)

1. Registrar SHAs aprovados e conferir o histórico remoto sem force push. Manter criação desligada. Definir responsáveis, janela e critérios de interrupção.
2. Operador autorizado realiza `pg_dump --format=custom` do banco e guarda o arquivo cifrado/restrito fora do Git, com checksum e identificação do snapshot. Credenciais via perfil protegido/PGPASSFILE; chaves criptográficas são copiadas para cofre separado. Não enviar dump ou segredo pelo chat.
3. Restaurar com `pg_restore --exit-on-error` em banco vazio e isolado, sem `--clean` sobre banco existente; conferir migrations, contagens, vínculos pedido/item/pagamento, credenciais decifráveis, eventos/outbox e valores amostrados. A suíte testa dump/restore de schemas sintéticos no PostgreSQL existente, incluindo ciphertext e FKs; isso não substitui o ensaio autorizado do backup de produção.
4. Listar migrations pendentes com o CLI Knex no perfil correto, revisar e aplicar primeiro ao banco restaurado. Validar versões anteriores e migrations forward-only. Nunca executar `down` como estratégia de retorno. Esta fase não aplica nada em produção.
5. Provisionar HTTPS estável e validar DNS/certificado, callback POST e retorno GET no backend correto. Não reutilizar endpoints de produção em homologação. Se houver proxy/túnel, validar a identidade e o encaminhamento de IP antes de expor o servidor; não aplicar `trust proxy=true` ou confiar indiscriminadamente em headers. O túnel H1 não é reutilizado automaticamente.
6. Definir perfil completo, origens/CORS, domínio dos cookies, chaves separadas e acesso administrativo. Validar persistência do cookie HttpOnly Secure e CSRF, inclusive retorno entre domínios. Configurar worker supervisionado, encerramento com drenagem e alertas das filas, com logs sanitizados.
7. Executar fluxo legado, fluxo financeiro simulado completo, relatórios/exportações e entrega isolada idempotente. Verificar ausência de impressão física e conexões operacionais reais. Somente depois solicitar homologação real de Crédito e autorização da próxima fase.
8. A composição de produção permanece preparada e inativa, sem autorizador nem destino operacional instalados. Antes de implantação comercial, aprovar banco/origens, proxy confiável, autorizador, adaptador operacional e política de reprocessamento/reconciliação. Em qualquer incidente, desligar criação preservando credenciais, worker autorizado e evidências. Reverter Git não reverte o banco nem cancela links já criados.

### Composição de produção preparada (Fase 5D.1, sem ativação comercial)

`NODE_ENV=production` sozinho não seleciona a integração. `INFINITEPAY_MODE=production` prepara o runtime existente somente quando a identidade e o ingresso foram validados; não liga criação nem worker. O servidor padrão não instala `productionAuthorization` nem `operationalAdapter`. O autorizador testado na Fase 5D.2 e o futuro destino real dependem de instalação/homologação autorizadas antes de qualquer ativação real. Não há endpoint ou comando habilitado nesta fase para emitir autorização financeira em nome do operador.

Configuração futura obrigatória: `INFINITEPAY_DATABASE_NAME`, `INFINITEPAY_DATABASE_ID`, conexão PostgreSQL correspondente, `INFINITEPAY_PUBLIC_ORIGIN`, `INFINITEPAY_SUCCESS_URL` terminando em `/pedido/sucesso`, origens HTTPS exatas em `INFINITEPAY_ALLOWED_PUBLIC_ORIGINS` e `ALLOWED_ORIGINS`, e `INFINITEPAY_TRUSTED_PROXY_IPS`. A identidade é o UUID persistido no registro único de `infinitepay_identidade_ambiente`; a migration inicializa `NAO_CONFIGURADO`, nunca `PRODUCAO`. A vinculação do ambiente será uma operação futura expressamente autorizada. Não se trata de multitenancy. O nome, host/porta configurados, banco efetivamente conectado e marcador persistido são conferidos. PostgreSQL remoto exige TLS com `rejectUnauthorized=true`; uma CA privada pode ser fornecida por `DB_SSL_CA` no cofre, sem arquivo versionado ou URL com opções que alterem TLS.

O perfil de ingresso aceita apenas um salto com IPs exatos, sem `trust proxy=true` ou contagem indiscriminada. Rejeita acesso direto de outro peer, Host divergente, protocolo diferente de HTTPS, cadeia XFF múltipla e headers Forwarded ambíguos. O proxy real deverá sobrescrever os headers recebidos do cliente e o firewall deverá impedir acesso direto ao backend. A aplicação continua vinculada a loopback nesse perfil. Isso prepara um contrato de ingresso; não certifica nenhum proxy, DNS, certificado ou domínio real.

`INFINITEPAY_CHECKOUT_ENABLED`, `INFINITEPAY_WORKER_ENABLED`, `INFINITEPAY_VERIFY_ENABLED` e `INFINITEPAY_DELIVERY_ENABLED` ficam `false`. Além das flags, a composição exige `productionAuthorization(context) === true`, com contexto contendo banco, UUID da implantação, ambiente, origem e uma operação específica: `WORKER`, `CREATE_LINK`, `VERIFY_PAYMENT` ou `DELIVER_ORDER`. A política é consultada em preflight e novamente antes de efeitos; não é assinatura de webhook nem token público. A implementação da Fase 5D.2 abaixo permanece sem instalação no servidor. Ausência, erro ou resposta diferente de `true` bloqueiam. Não fornecer funções permissivas em implantação. Criação também exige credencial decifrável, classificação Pix/Crédito, configuração administrativa ativa e consumidor disponível. Chaves antigas continuam necessárias para verificar tentativas antigas.

Eventos e entregas possuem seletores separados no runtime. O worker preparado só inicia com flag e autorização próprias; cada ciclo e transporte continuam sujeitos à política. Entrega isolada de outbox pode funcionar sem processar eventos e sem chamar `payment_check`. Em emergência, desabilitar novas criações preservando somente a verificação/entrega que continuarem expressamente autorizadas. O mecanismo não promete revogar um HTTP já iniciado. Não ligar worker genérico sobre H4 nem reprocessar seus eventos pendentes.

`createDurableOrderConsumer` usa as tabelas `infinitepay_entregas_operacionais` e `infinitepay_entregas_tentativas`. Exige pagamento PAGA/LIQUIDADA com prova completa na mesma tentativa antes de um novo envio, associa chave/outbox/pedido/destino e registra tentativas, lease e recibo mínimo. Não carrega API Key nem recebe cliente financeiro. A composição injeta `authorizeSend` antes da revalidação final de elegibilidade e lease; nenhuma autorização lenta pode ser aguardada entre essa checagem final e o envio. O adaptador deve fornecer `id`, `supportsIdempotency`, `send(dto,{signal})`, `lookupReceipt(dto,{signal})` e `verifyReceipt(receipt,dto,{signal})`. O recibo contém `{acknowledged:true,key,pedidoId,destination,receiptId}`; só é aceito após correlação e verificação do destino. Socket.IO emitido ou confirmação local de envio não equivalem a recebimento autenticado.

Timeout, processo encerrado e falha ao persistir reconhecimento deixam entrega INCERTA ou lease recuperável. `deliver` não reenvia uma entrega incerta. A futura operação autorizada `recover(key)` consulta o recibo do destino; só reenvia com a mesma chave quando a ausência foi confirmada e o adaptador declara idempotência. Essa declaração precisará ser comprovada no destino real. Uma entrega RECEBIDA permite reconhecer novamente a outbox sem novo envio. Teto de tentativas conserva registros para intervenção; não há exactly-once externo garantido. Auditoria usa códigos sanitizados, sem payload financeiro ou exceções livres do destino.

As migrations 20261027 são aditivas e forward-only, testadas somente em schemas descartáveis. Não são aplicadas automaticamente pelo servidor. H4 e DEMO certificados permanecem com seu schema anterior; validadores que exigem lista exata de migrations podem indicar as novas pendências. Não executar Prepare/migrations nesses bancos para contornar esse bloqueio. Os scripts H1/H2/H3/H4 e o DEMO não foram adaptados para desenvolvimento de produção.

Permanecem pendentes a autenticidade contratual do webhook, recuperação externa/idempotência de criação, estorno/liquidação, instalação autorizada do controle administrativo e do destino real, supervisão/alertas, HTTPS final, backup/restauração e implantação autorizada. `paid` continua sinal; `settled` não comprova repasse. O risco preexistente do PEM e da assinatura QZ permanece descrito em `docs/infinitepay/PLANO_SEGURANCA_QZ_PEM.md`, sem alteração ou exposição do material privado nesta fase.

### Contratos de autorização e destino (Fase 5D.2, não ativados)

`createProductionAuthorizer({db,env,now,sessionSecret})` prepara `approve`, `authorize`, `revoke` e `emergencyStop`. Não é instanciado pelo servidor padrão e não cria rotas ou aprovações automaticamente. A migration `20261027000300_autorizacoes_producao.js` acrescenta aprovações e decisões auditáveis e a permissão `pagamentos.ativar_producao`, sem atribuí-la a usuários. Sua aplicação continua restrita a bancos descartáveis nesta fase.

A futura instalação deverá manter uma instância do autorizador por processo e iniciar o servidor com flags financeiras desabilitadas. O controle administrativo deverá obter aprovação antes de habilitar flags e solicitar start do worker; a recusa de start não deve ser contornada para conseguir boot. Reboot não reutiliza a aprovação anterior. A sequência de controle administrativo ainda não está instalada.

O futuro controle administrativo deverá passar ao serviço metadados extraídos pelo servidor: `session:{token,origin,csrf}`. `approve({session,capabilities,validForSeconds,credentialId?,destinationId?})` valida JWT HS256 assinado pela aplicação, usuário e nível ativos, permissão explícita (sem bypass pelo nome admin), Origin HTTPS exata e CSRF da sessão existente. A validade fica limitada a quinze minutos e à expiração do JWT, com padrão de cinco minutos; a política de duração para operação contínua deverá ser validada antes da implantação. Nenhum acesso de acompanhamento do comprador substitui essa sessão. O serviço recusa relógio regressivo, credencial ausente/indecifrável, mudança da implantação ou falha de auditoria. Chaves de sessão fortes precisam ser fornecidas por cofre; nenhuma chave real foi configurada nesta fase.

Cada aprovação é selada por HMAC com chave aleatória mantida somente na memória da instância, e vinculada ao boot, identidade persistente da implantação/banco, ambiente production, origem e fingerprint do envelope criptográfico da credencial. Reiniciar/reconstruir o autorizador exige nova aprovação; registros antigos continuam auditáveis, mas não restauram ativação. A identidade do banco representa a instalação única, sem multitenancy. O fingerprint e a decifragem autenticada verificam integridade/localização da credencial; não comprovam sua validade ou titularidade na InfinitePay sem consulta autorizada ao provedor.

As capacidades são independentes. A aprovação administrativa permite operações normais de clientes somente quando todos os outros gates também permitem; não exige nova aprovação do operador para cada clique, não é orçamento H4 e não muda a reserva idempotente por pedido. No despacho financeiro, a composição confere a credencial e o handle da tentativa original, compara a API Key em memória e pede autorização para esse ID de credencial. Uma aprovação de chave antiga permite somente WORKER/VERIFY_PAYMENT; não autoriza criação com outra chave. DELIVER_ORDER exige o destinatário exato aprovado. Nenhum arquivo de autorização da H4 é lido ou reaproveitado.

`revoke({session,id})` conserva o registro e revoga sua capacidade; `emergencyStop({session})` revoga aprovações da implantação e bloqueia novas aprovações nessa instância. Para retomar, reconstruir o autorizador e obter aprovação administrativa nova. Decisões são persistidas com operação, resultado, código fixo e IDs internos, sem JWT, CSRF, API Key, payload financeiro ou erro livre. Se a auditoria não puder ser gravada, não há autorização; uma falha de armazenamento pode impedir o próprio registro da negativa. A revogação bloqueia decisões seguintes e não cancela HTTP ou efeitos externos já autorizados/em trânsito. Outras instâncias precisam consultar a política e drenar operações conforme o supervisor futuro; não se promete revogação física instantânea.

`createOperationalEnvelope(dto,{destination,deploymentId})` e `normalizeOperationalEnvelope` definem versão 1: identificador determinístico da entrega, chave persistente, implantação, outbox, destinatário e payload mínimo `{pedidoId,tipo:'PEDIDO_LIBERADO'}`. Campos não previstos, identidades vazias, destinos inválidos ou divergências são rejeitados. Identificadores não são autenticação. Dados de cliente, itens de impressão e segredos não são transportados nesse contrato mínimo; o futuro destino deverá obter apenas os dados autorizados necessários por contrato próprio.

`createSyntheticOrderDestination({db,secret,id,now,behavior})` implementa recebimento persistido com unicidade, recibo HMAC-SHA256 conferido contra o registro do receptor sintético, consulta e repetição idempotente. Exige conexão loopback, banco infinitepay_*test e schema iptest_* descartável; confere identidade efetiva e implantação antes das operações. Não aceita H4/H1, DEMO persistente ou produção. O armazenamento fake é criado explicitamente pelo teste; não existe migration nem inicialização automática de receptor sintético em produção.

A simulação cobre falha anterior ao recebimento, indisponibilidade, timeout após commit, recibo ausente/inválido/duplicado e reinício. Recuperação reutiliza o consumidor durável existente; uma recepção incerta não é retransmitida automaticamente. O recibo sintético declara RECEIVED e printed=false. Liberação lógica (pagamento comprovado), envio (tentativa), recebimento verificado (recibo) e impressão física são estados distintos. O HMAC e a unicidade comprovam somente o modelo sintético; não homologam idempotência, autenticação ou impressão do destino real.

O caminho atual Socket.IO/NotificationListener/QZ não devolve recibo durável autenticado ao Backend e usa deduplicação volátil. A [API oficial QZ](https://qz.io/api/qz) esclarece que a promise de print pode resolver antes da conclusão física. Não foi construído adaptador operacional baseado nessa promise. As limitações e o plano de contenção permanecem no documento QZ separado, sem alteração do assinador ou da impressão existente.

Continuam pendentes a instalação autorizada do controle administrativo, destino real, contratos externos InfinitePay, infraestrutura e homologação operacional. A documentação InfinitePay consultada em 28/10/2026 continua sem contrato suficiente de assinatura de webhook, idempotência externa e recuperação após perda de resposta; nenhum mecanismo foi inventado. Nenhum worker real ou checkout comercial foi ativado. As três migrations 20261027 permanecem não aplicadas aos bancos certificados.

### Controle administrativo preparado (Fase 5D.3, inativo)

`createProductionControlRouter({authorizer})`, em `src/routes/InfinitepayProductionControl.Routes.js`, é uma fábrica sem efeito de instalação. Nenhum import/mount foi acrescentado à composição, nenhuma variável a instala e nenhuma permissão é atribuída automaticamente. Não há interface de ativação no Frontend. Os caminhos abaixo são **relativos ao módulo não montado**, não URLs disponíveis no servidor:

| Método / caminho relativo | Contrato JSON | Efeito permitido |
|---|---|---|
| GET `/` | sem corpo | Estado da instância e até 100 aprovações mais recentes desse boot: ID administrativo, validade, revogação e capacidades efetivamente válidas. Não expõe hashes, credenciais ou tokens. |
| POST `/approvals` | `{capabilities,validForSeconds?,credentialId?,destinationId?}` | Persiste aprovação e auditoria na mesma transação; retorna 201. Não liga flags nem inicia worker. |
| POST `/revocations` | `{id}` | Revoga aprovação da instalação, preservando histórico; retorna 200 e `revoked` booleano. Não aceita ID de outro ambiente como sucesso. |
| POST `/emergency-stop` | `{}` | Revoga aprovações da instalação e bloqueia novas aprovações na instância; retorna 200 somente após persistência. Não promete cancelar operações externas em trânsito. |

Respostas usam `{status:'success',data}` ou erro com código fixo, `Cache-Control:no-store` e `Referrer-Policy:no-referrer`. É exigido HTTPS; sessão vem exclusivamente de `cookies.token`, Origin do header e CSRF de `X-Infinitepay-CSRF`, inclusive na consulta. O serviço confere JWT HS256, usuário/nível ativos e permissão explícita `pagamentos.ativar_producao`, sem bypass pelo nome do cargo. Escritas exigem application/json e corpo restrito; campos de sessão, implantação e banco no JSON são rejeitados. O parser próprio limita a 8KiB; o proxy e qualquer parser anterior também deverão limitar requisições na futura instalação. Erros de autenticação/autorização são 403, corpo inválido 400, mídia 415, excesso 413 e indisponibilidade de controle/persistência 503. Não há logs de request, headers ou exceções livres neste módulo.

`authorizer.status({session})` revalida capacidades com a política existente, incluindo HMAC, credencial e auditoria obrigatória de cada decisão avaliada. Consulta não gera aprovação, operação financeira ou renovação. Não é uma consulta ao estado bancário nem prova de que um worker esteja rodando. Falhas de autenticação da consulta não geram uma nova categoria de auditoria; aprovações, revogações e decisões de capacidade usam as tabelas já existentes. Nenhuma migration foi necessária.

A montagem futura exige composição explícita revisada, `configureProductionProxy` antes das rotas, IPs exatos do proxy, Host/HTTPS encaminhados validados, cookies seguros e rate limiting existente. O router não estabelece confiança em headers por conta própria. A emissão inicial do CSRF precisa usar o mecanismo autenticado existente: hoje a leitura da configuração financeira o fornece a quem também possui `pagamentos.configurar`. Um administrador com somente `pagamentos.ativar_producao` precisará de bootstrap autenticado aprovado antes da instalação, sem fornecer segredo JWT ao navegador. Não foi criada autenticação paralela. Logout do navegador não revoga criptograficamente um JWT já emitido: neste modelo a validade é conferida por expiração, chave de sessão e estado/permissão no banco; revogação imediata de sessão individual exigiria contrato próprio.

#### Continuidade: política conservada e decisão ainda necessária

O contrato atual é adequado a uma janela supervisionada de homologação, não a um turno comercial sem intervenção. Permanece padrão de cinco minutos, máximo quinze e nunca além do JWT. Não há renovação automática nem aprovação permanente. A identidade persistente representa a instalação; a aprovação é adicionalmente vinculada ao boot e não sobrevive à reconstrução do autorizador. As quatro capacidades não se implicam entre si.

| Nível | Regra atual / condição futura |
|---|---|
| Aprovação da implantação | Declaração administrativa para banco, origem e credencial exatos; não é implantação/deploy nem habilita flags. |
| Capacidade operacional | WORKER, CREATE_LINK, VERIFY_PAYMENT e DELIVER_ORDER independentes, com validade e destino quando aplicável. Flags continuam sendo outro bloqueio. |
| Operação individual | Requer política válida no despacho e os registros/idempotência próprios da tentativa ou entrega. A aprovação de capacidade não é um voucher de uso único. |
| Expiração | Novas decisões negadas, sem renovar ou limpar reservas. Callbacks podem ser persistidos, mas a consulta independente aguarda nova autorização VERIFY_PAYMENT/WORKER. Links externos existentes podem continuar pagáveis. |
| Revogação | Bloqueia decisões seguintes; não desfaz prova financeira recebida de uma consulta já autorizada e enviada. Uma resposta válida em trânsito pode confirmar e gerar outbox lógica; entrega física segue separadamente bloqueada. |
| Emergência | Revogação persistida e bloqueio na instância; supervisão deve drenar/parar processos e observar resultados em trânsito. Não é cancelamento de cobrança no provedor. |
| Reinício | Flags não são aprovação; sem uma nova aprovação explícita, nenhuma capacidade é herdada. Começar com flags desligadas, validar identidade, revisar pendências e obter aprovação antes de start. |

Alternativas **para decisão do operador, não implementadas**: (A) conservar as janelas curtas com renovação humana explícita e aceitar pausas de verificação/entrega; (B) separar uma aprovação de implantação com prazo de turno definido de leases curtos de capacidade, supervisão/heartbeat e revogação durável, mantendo nova aprovação após reinício. B exige definir prazo máximo, responsáveis, quórum, tratamento de sessão expirada, capacidades de drenagem e parada entre instâncias; requer mudança revisada do contrato/schema, nunca simplesmente aumentar TTL ou ignorar JWT. Nenhuma capacidade deve continuar implicitamente após a sessão sob a política atual. Ativação comercial permanece bloqueada até aprovação da política, bootstrap CSRF, instalação revisada e ensaio de recuperação.

Limites comprovados pelos testes: auditoria indisponível impede aprovação/uso; em revogação/parada com falha de persistência o processo nega localmente, mas não pode alegar que a mudança foi propagada/durável. É necessário tratar o 503 e supervisionar a parada. HMAC por boot não é trilha inviolável contra administrador do banco/host; auditoria externa/retentiva e exclusão mútua operacional entre réplicas continuam decisões de implantação. Nenhum software local garante cancelamento de HTTP ou impressão já enviada; reconciliação preserva evidências e nunca reenvia automaticamente uma cobrança incerta.

#### Contrato para o futuro destino operacional real

O envelope mínimo versionado e o consumidor durável existentes continuam sendo a base. É necessário escolher e homologar transporte, autenticação entre serviços/estações, destinatário/implantação, retenção da deduplicação e responsável operacional antes de construir o adaptador real. Não conectar o emit legado diretamente à outbox como se fosse recibo.

| Etapa | Evidência e recuperação exigidas do destino real |
|---|---|
| Financeiramente liberado | Prova independente válida, PAGA/LIQUIDADA com valor/identificadores vinculados à mesma tentativa; não aceitar somente webhook/redirect. Estorno continua um estado distinto, não libera nova entrega. |
| Entrega lógica | Outbox única e chave persistente por pedido; envelope com versão, implantação, destinatário, pedido e chave. Não incluir credenciais financeiras. |
| Envio | Lease/fencing e autorização válidos; registrar tentativa antes do envio, reutilizando a mesma chave. |
| Recebimento durável | Destino grava atomicamente chave, correlação e resultado antes de responder; recibo autenticado e verificável, consultável depois de reiniciar e sem novo efeito em repetição. |
| Timeout / falha | INCERTA não significa ausência de recebimento. Consultar recibo; só repetir com ausência confirmada e idempotência comprovada, sem recriar cobrança. |
| Recuperação | Consultar pela chave persistente; o receptor deve conservar deduplicação/recibo por prazo aprovado, inclusive em reinstalação ou troca de estação. Resolver divergências sob supervisão. |
| Confirmação do funcionário | Ação separada, autenticada e persistida com usuário ativo, papel/permissão operacional, pedido/chave e horário; não equivale a aprovação financeira nem autoriza reimprimir automaticamente. O formato ainda precisa de aprovação. |
| Impressão física | Estado independente e somente quando houver prova por trabalho/modelo/versão efetivamente homologada. Não usar resolução de qz.print, ack Socket.IO ou clique humano como prova de saída física. |

Socket.IO atual não retorna recibo durável ao Backend, e a deduplicação do NotificationListener é volátil. Uma futura decisão sobre receptor central ou estação responsável deverá evitar duas estações imprimirem o mesmo trabalho e definir reimpressão manual autorizada. Testes continuam exclusivamente no receptor sintético; HMAC/recebimento sintético não certificam impressora real. O plano QZ separado contém o diagnóstico e as medidas propostas para autorização posterior.

## Demonstração local persistente (sem dinheiro real)

O launcher `scripts/infinitepay-demo.ps1` usa PowerShell 7.2+, Node, PostgreSQL18 e o OpenSSL do Git já instalados nesta máquina. Reutiliza **127.0.0.1:55439/infinitepay_phase1_test**, criando somente o schema persistente **infinitepay_demo**. Os testes automáticos continuam usando seus próprios schemas descartáveis. Não acessa H1/55440 ou produção. `Prepare` aplica somente migrations pendentes nesse schema identificado e inicializa dados uma vez, sem apagar registros, executar seeds destrutivos ou redefinir configurações a cada início.

Comandos no PowerShell, a partir de qualquer diretório (ajuste apenas o caminho do checkout se ele for movido):

```powershell
$demo = 'C:\Users\Passare Store 02\Documents\Codex\2026-10-22\files-mentioned-by-the-user-00\work\Saas-Marmitaria-Backend\scripts\infinitepay-demo.ps1'
& $demo -Action Start       # PostgreSQL existente + preparação idempotente + Backend + Frontend
& $demo -Action Status      # PIDs próprios, identidade do ambiente e worker
& $demo -Action Access      # Exibe somente ao operador a senha sintética inicial
& $demo -Action Open        # Abre a loja no navegador padrão
& $demo -Action Logs        # Consulta logs privados/sanitizados
& $demo -Action Stop        # Drena Backend e encerra somente os processos identificados da demonstração
```

Também é possível iniciar separadamente com `-Action Postgres`, `-Action Backend` e `-Action Frontend`. O PostgreSQL compartilhado com regressões não é parado por `Stop`; os dados permanecem disponíveis depois de fechar o navegador ou reiniciar os serviços. PIDs são conferidos por início, executável e script antes de encerrar qualquer processo. `Start` recusa portas ocupadas por serviços não identificados.

URLs exclusivamente locais:

- Loja: **https://localhost:55445/pedido**.
- Administração: **https://localhost:55445/auth/login**, e-mail **admin@demo.invalid**, senha obtida por `Access`.
- Simulador: **https://localhost:55446/__demo**, depois do login administrativo.
- Pedidos e consulta financeira: **https://localhost:55445/admin/pedidos**; em **Pedidos do Dia**, o ícone de comprovante ao lado de Imprimir aparece para comprovantes autorizados e usuários com `pagamentos.visualizar`. Cada clique consulta novamente o Backend e abre uma aba protegida. A aba **Pagamentos InfinitePay** continua disponível para pendências e administração financeira.
- Relatórios: **https://localhost:55445/admin/relatorios**; dashboard: **https://localhost:55445/admin**.

São certificados exclusivos de localhost, válidos por um ano, sem alteração de QZ/PEM. O navegador inicialmente pode avisar que a autoridade não é reconhecida. Para confiar somente nesse certificado no usuário Windows atual, execute `& $demo -Action TrustCertificate`, confira a impressão digital exibida e digite a confirmação solicitada. A confiança **não é instalada automaticamente**. Backend, Next e comandos de status/encerramento validam a CA local sem `NODE_TLS_REJECT_UNAUTHORIZED=0` ou desativar verificação TLS. Não exponha essas portas à rede ou a um túnel público. Para inspecionar mobile use o modo de dispositivo do navegador local.

O perfil, senha sintética, segredos próprios, certificado/chave TLS, PIDs e logs ficam em `work/infinitepay-demo-private`, fora dos dois repositórios, com ACL restrita ao operador e SYSTEM. Não apague esse perfil: ele preserva a capacidade de ler as credenciais sintéticas e acessar o histórico após reiniciar. Não cadastre API Key real. A credencial financeira aceita neste modo é somente `SYNTHETIC_INFINITEPAY_DEMO_ONLY`; a conta é `demo-sintetica`, sem usar a conta homologada H1. A flag pública `NEXT_PUBLIC_INFINITEPAY_DEMO=local-only` não contém segredo e é recusada fora de development. Origens locais só são admitidas por esse perfil explícito; os fluxos normais conservam as origens oficiais.

Dados disponíveis: tamanhos P/M/G (R$15/20/25 sintéticos), arroz, feijão, proteínas e salada; quatro especiais DEMO; Água/Sobremesa DEMO; Pix, Crédito, Dinheiro e Débito; empresa e administrador sintéticos. A loja começa aberta e a impressão automática desligada. Mudanças feitas manualmente são preservadas.

Para testar, monte uma marmita comum ou especial, adicione complementos e finalize. Pix/Crédito abrem o checkout **local**, onde os botões simulam aprovação pelo provedor. Antes de aprovar, **Continuar aguardando** permite consultar/recarregar o pedido pendente. Depois de aprovar, use **Voltar ao acompanhamento** e aguarde a confirmação do Backend. O comprovante mostra claramente que não possui valor financeiro. Dinheiro/Débito seguem o fluxo posterior existente.

No simulador administrativo, escolha **Pendente**, **Resposta perdida** ou **Erro de rede** para o próximo checkout; o cenário volta a Pendente após um envio. Resposta perdida persiste o link no provedor sintético e mantém INCERTA no sistema; o operador pode abrir o mesmo link pelo painel e aprová-lo, sem criar outro. Erro de rede não cria link no simulador, mas o Backend conserva INCERTA porque não presume essa informação interna. **Reenviar webhook** exercita a deduplicação. Nenhuma ação atualiza diretamente PAGA: a prova vem do cliente `payment_check` com transporte sintético, passando pelo serviço financeiro, worker e outbox existentes. O consumidor registra somente o recebimento durável isolado; atualize a administração para consultar o pedido liberado.

O transporte de simulação não faz rede. O processo Backend recusa fetch externo; o navegador recebe CSP exclusiva de demonstração bloqueando conexões QZ e diálogos de impressão, e `/qz` é recusada pelo gateway local sem alterar o módulo original. Não tente contornar essas proteções para imprimir. O cache `.next-demo` mantém a demonstração separada do build/regressões normais.

`npm run test:demo`, no Frontend com os serviços já ativos, verifica login, desktop/mobile, marmita comum/especial, complementos, quatro meios, pendência, prova independente, comprovante, administração e INCERTA recuperável. Cria somente pedidos sintéticos e **não encerra os serviços nem remove esses registros**. As suítes normais continuam em `npm test` e `npm run test:browser`.

### Passagem futura da demonstração para homologação real de Crédito

Este perfil não pode receber credencial real nem criar checkout real. A proposta de R$1,00 em 1x continua **condicionada à confirmação oficial do mínimo no Checkout Integrado para essa conta**. A pesquisa na documentação oficial não encontrou esse mínimo; artigos sobre pagamento mínimo da fatura ou outros produtos não comprovam o contrato de criação do checkout. Solicitar a confirmação no suporte oficial e registrar a resposta antes de pedir autorização da transação.

O launcher `scripts/infinitepay-credit.ps1` prepara **127.0.0.1:55439/infinitepay_credit_homologacao**, banco exclusivo e persistente, com identidade própria, migrations pendentes e sem pedidos/tentativas iniciais. Não reutiliza os bancos DEMO ou H1. Perfil e chave criptográfica próprios ficam em `work/infinitepay-credit-private`, fora do Git, sob ACL exclusiva do operador/SYSTEM. Não apague esse diretório. `Prepare` é repetível e recusa banco preexistente sem identidade; não executa seeds nem redefine dados. Os dados sintéticos de validação dos callbacks permanecem pendentes.

```powershell
$credit = '<caminho do Backend>/scripts/infinitepay-credit.ps1'
& $credit -Action Prepare
& $credit -Action Status
& $credit -Action Tunnel  # reutiliza o processo identificado; inicia em segundo plano somente antes da reserva real
& $credit -Action Backend # somente callbacks; imprime PID próprio
& $credit -Action Preflight # HTTP/HTTPS, proxy, deduplicação e retorno sintéticos; nenhuma API financeira
& $credit -Action Credential # opcional: entrada protegida pelo operador, sem enviar pelo chat
& $credit -Action Diagnose # somente leitura: requisitos, DPAPI, processos, banco e GETs HTTPS sem eventos
```

`Diagnose` distingue APROVADO, BLOQUEADO, AGUARDANDO AUTORIZAÇÃO e NÃO VERIFICADO. Confere a leitura DPAPI pelo operador sem enviar a chave ao Node; somente seu fingerprint transitório é usado para comparar uma autorização já existente. O PostgreSQL usa sessão/transação somente leitura e o HTTPS recebe apenas GETs sem parâmetros, sem criar eventos. `AUTHORIZATION_FILE_MISSING` identifica a ausência da autorização específica antes de qualquer reserva ou envio; variar o valor não resolve esse bloqueio. O diagnóstico não cria autorizações nem substitui o pré-teste sintético de POST/deduplicação. Conta/permissões da API Key e mínimo não comprovado permanecem explicitamente não verificados.

O executável portátil oficial `cloudflared.exe` fica no perfil Crédito; obtenha pelo [download oficial](https://developers.cloudflare.com/tunnel/downloads/) e confira o SHA256 do release se for necessário reinstalá-lo. Quick Tunnel é temporário, sem garantia de disponibilidade contínua: sua origem vale enquanto esse processo e a conexão permanecerem ativos. PID, início, caminho e comando são conferidos antes de reutilizar os processos; `StopBackend` encerra somente o Backend identificado, preservando túnel, PostgreSQL e registros. Não reutilizar H1. A origem é fixada no banco e qualquer troca fica bloqueada após a reserva real, inclusive depois de timeout. Se o túnel cair durante uma tentativa ativa, interromper o teste e conciliar; não gerar outra cobrança, trocar callbacks ou apagar a reserva. Antes da primeira reserva, `Tunnel` pode descobrir uma nova origem efetiva e `Backend`/`Preflight` precisam ser executados novamente. Não há URL fixa inventada ou versionada.

Somente `/pagamentos/infinitepay/webhook` (POST), `/pagamentos/infinitepay/retorno` (GET) e `/pedido/sucesso` (GET) são expostos. GET de webhook retorna405; retorno sem identificadores válidos retorna400. Nenhuma rota de criação/consulta financeira, QZ, Socket.IO ou administração é exposta. A identidade do peer TCP é atestada no Windows contra o PID/executável do cloudflared na porta55447, reutilizando o verificador H1 com sua porta padrão preservada. Somente o salto local comprovado pode fornecer o `CF-Connecting-IP`; XFF arbitrário é descartado e chamadas diretas com headers encaminhados são rejeitadas. Rate limiting continua ativo. Eventos/retornos brutos são armazenados cifrados com chave exclusiva de Crédito e metadados locais, sem impressão de payloads ou identificadores. Formatos não homologados não aprovam pagamento.

A credencial é armazenada via DPAPI/ACL e **não é carregada** pelo servidor de callbacks. `NODE_ENV=development`, checkout/configuração do banco desligados e worker parado. Os comandos de criação e consulta só carregam a chave após localizar autorização privada específica para aquela operação, valor, origem, conta e fingerprint da credencial; em seguida exigem TTY e frase exata. Nenhuma API Key entra em argumento de processo, `NEXT_PUBLIC`, logs ou Git; seu uso eventual é somente no processo local do comando autorizado e no header do cliente existente. Não copiar chaves H1.

Na H4.2, R$1,00 é proposta baseada em pesquisa/experiência do operador, sem certificação do mínimo do Checkout Integrado nem garantia de aceitação. O operador pode, em etapa posterior, conceder `AuthorizeCreateLink -AmountCentavos 100`. O comando exige terminal interativo e a frase **`AUTORIZO UM LINK H4 BRL 100 CREDITO 1X CONTA matheuszxp MINIMO NAO CONFIRMADO`**, declarando também que conferiu no App a conta da credencial. A API não foi consultada para comprovar titularidade: o registro diz `OPERATOR_DECLARED`, nunca conta verificada pelo provedor. A aceitação expressa do mínimo incerto fica em campos próprios, sem preencher evidência de suporte fictícia. Uma política comprovada que impeça o valor exige interromper e revisar; não testar valores alternativos.

O registro revalida o diagnóstico antes/depois da confirmação, grava exclusivamente `approval-CREATE_LINK.json` no diretório privado com sincronização em disco e criação exclusiva, sem sobrescrever arquivo existente. Não carrega a API Key no Node, não altera o banco, não reserva pedido nem envia cobrança. Vincula BRL100, Crédito pretendido1x, banco/porta/finalidade H4, conta declarada, fingerprint DPAPI, origem vigente, uma referência UUID de tentativa e uso único, com validade de15minutos. Essa referência será persistida como `client_request_id` do pedido e associada à tentativa na transação de reserva. Troca de credencial/origem, prazo vencido ou divergência bloqueiam o envio. Se um arquivo existir/vencer, preservar e solicitar revisão/renovação controlada; não apagá-lo ou editar datas. Nenhuma autorização foi concedida pelo código ou pela preparação.

`Preflight` cria/reutiliza somente um fixture próprio H4, claramente sintético e com tentativa `FALHOU`, sem credencial/envio ao provedor. Exercita nonce/retorno do runtime existente sem liberar cozinha nem outbox. Não usa registros H1/DEMO, não representa o pedido financeiro real e não pode gerar link. `Status` distingue contagens sintéticas da reserva/envios reais. `Events` e `CheckEvidence` consultam metadados e vínculo local sem chamadas ao provedor. Essas leituras, `Status`, `ViewCheckout` e `CheckResult` usam conexão PostgreSQL somente leitura. O retorno H4 não cria autenticação paralela: é correlacionado pelo nonce do runtime e não depende de React Context ou cookie como prova financeira. Cookie de diagnóstico em teste de navegador não autentica nem aprova o pedido.

Comandos preparados **para uso somente após autorização específica de cada operação**, além da confirmação interativa:

```powershell
& $credit -Action AuthorizeCreateLink -AmountCentavos 100 # futura decisão humana; registra autorização, nenhum POST
& $credit -Action Diagnose                     # revisão após registrar; não substitui a confirmação de execução
& $credit -Action CreateLink -AmountCentavos 100 # um único POST /links; hoje bloqueado
& $credit -Action Status                       # consulta somente leitura, sem API financeira
& $credit -Action ViewCheckout                 # URL já criada, validada, somente terminal interativo
& $credit -Action Events                       # tipos/estados/contagens, sem identificadores privados
& $credit -Action CheckEvidence                # confere IDs locais e snapshot; não faz payment_check
& $credit -Action DiagnosePayment              # diagnóstico somente leitura da tentativa existente e suas autorizações
& $credit -Action AuthorizeCheckPayment -AmountCentavos 100 # futura decisão humana: registra somente a autorização de consulta
& $credit -Action CheckPayment -AmountCentavos 100 # única consulta autorizada, modo observação
& $credit -Action CheckResult                  # lê evidência; não aprova operacionalmente
& $credit -Action AuthorizeReconcile -AmountCentavos 100 # só após prova independente válida; não reconcilia
& $credit -Action Reconcile -AmountCentavos 100 # autorização separada; prova armazenada e vínculo revalidados
& $credit -Action AuthorizeDeliver -AmountCentavos 100 # só após PAGA e outbox única; não entrega
& $credit -Action Deliver -AmountCentavos 100   # autorização separada; consumidor durável exclusivamente isolado
```

Os100centavos acima são a proposta, não autorização previamente concedida. O registro de autorização e a execução são passos separados: a criação exige novamente **`CREATE_LINK H4 CREDITO 100 CENTAVOS`**. Se houver recusa ou resposta incerta, não repetir POST nem substituir valores. Consultar `Status` e `ViewCheckout`; manter túnel/backend ativos, abrir manualmente a URL validada do domínio oficial, conferir R$1,00 e selecionar Crédito1x. `assured_installments=1` não limita as parcelas; não escolher outro parcelamento automaticamente. `CheckPayment`, `Reconcile` e `Deliver` continuam com autorizações privadas próprias e não são autorizados pelo registro de criação. A pergunta ao suporte permanece: **“Qual o mínimo de uma venda de Crédito à vista, em1x, via POST /links do Checkout Integrado para minha conta? R$1,00 é aceito? Há restrições por bandeira/conta e existe configuração documentada que limite a compra a1x, distinta de assured_installments?”** Guardar confirmação aplicável, sem teste exploratório de valores alternativos.

Na criação autorizada, o orquestrador existente calcula itens/valor, reserva o pedido e a tentativa e usa `order_nsu` exclusivo. Um orçamento único durável impede qualquer segundo POST, inclusive depois de timeout/crash/reinício. O adaptador H4 restringe os meios a `credit_card`, mantém `single_payment=true`, sem descontos e validade no fim do dia em America/Sao_Paulo. HTTP200 ou URL recebida não confirmam pagamento. Respostas incompletas, URL inválida e timeout mantêm bloqueio e INCERTA; consultar a tentativa/URL existente, nunca repetir criação. A URL só aparece no terminal do operador e não é consultada externamente para “testar” uma nova cobrança.

Após autorização e link válido, o operador confere o valor e escolhe Crédito/1x no checkout oficial, sem fornecer dados do cartão à marmitaria. Manter túnel/Backend ativos; não pagar novamente se o retorno falhar. Consultar eventos e vínculo local. `CheckPayment` exige autorização própria, IDs consistentes e usa a credencial vinculada à tentativa. A prova financeira requer HTTP/JSON válidos, `success=true`, `paid=true`, `amount` autorizado, `capture_method=credit_card` e parcela1 efetivamente observada. `receipt_url` não é obrigatório nessa resposta: o contrato oficial o apresenta no retorno/callback e o exemplo de payment_check não o inclui. `paid_amount` é preservado separadamente, sem inferir líquido/taxa. Falha, divergência ou timeout preservam bloqueio; a consulta também possui orçamento único sem retry automático. Não apagar seu marcador nem repetir a consulta para obter um comprovante.

A composição H4.4 separa a captura independente, o vínculo da tentativa e o comprovante. O leitor verifica a captura e a reserva da consulta contra o mesmo pagamento/contexto; preserva nonce, pedido/itens/hash, credencial, order_nsu/transação/fatura e campos identificadores que a resposta realmente fornecer. Se esse vínculo falhar, a prova não pode ser atribuída à tentativa. O comprovante é opcional: ausência mantém `receipt_available=false`, sem fabricar URL. Quando presente nos callbacks, exige os mesmos identificadores, nonce válido no retorno, domínio HTTPS permitido e caminho exato da transação verificada independentemente. URL divergente, não permitida ou ambígua bloqueia comprovante e reconciliação, mesmo que a prova financeira isolada seja positiva. Não se afirma assinatura autenticada do webhook e seu estado paid não confirma pagamento.

`CheckResult`/`DiagnosePayment` reavaliam os registros em transação somente leitura e mostram `evidence_sources`, `provider_echo_fields`, `receipt_status` e `reconciliation_ready`, sem URLs ou IDs completos. O manifest interno `H4_CREDIT_EVIDENCE_V2` associa o hash da captura original e as referências/hashes canônicos das fontes do comprovante. A autorização futura vincula esse manifest por `proof_sha256`; repetição da mesma fonte/URL não muda a associação. Nada é inserido na resposta original ou regravado nos eventos. Só na reconciliação posteriormente autorizada o serviço recebe um objeto normalizado com `receiptUrl` proveniente dessa associação validada. Não são necessárias migrations nem novas tabelas. Com a consulta já consumida, usar apenas as leituras locais para essa reavaliação, sem novo payment_check.

Check positivo permanece em observação: não muda para PAGA nem cria outbox. Só `Reconcile`, autorizado separadamente, revalida pedido/itens/hash, credencial, NSU/transação/fatura, nonce quando houver retorno e evidência cifrada, usando o serviço transacional existente, sem novo payment_check. `Deliver`, também autorizado, usa a outbox existente e grava somente o recebimento em `infinitepay_entregas_homologacao` com chave única. Conferir uma liberação, uma outbox e um recebimento, comprovante vinculado e valor original no relatório; nenhuma cozinha/impressora/Socket.IO real. Nenhuma dessas etapas foi executada financeiramente nesta preparação.

Depois de criado o link, use `DiagnosePayment`, `Status`, `Events`, `CheckEvidence` e `CheckResult` para consultas locais. `Diagnose` continua avaliando a preparação de uma nova criação, que ficará bloqueada pela reserva existente. Não executar novamente `CreateLink`, não renovar a autorização de criação nem trocar a origem: o prazo da autorização CREATE_LINK não determina a validade da consulta ao pagamento existente. `DiagnosePayment` confere identidade/migrations/configuração H4, origem persistida, vínculo entre pedido/tentativa/NSU/fatura/transação, snapshot, credencial decifrada e fingerprint DPAPI, sem imprimir identificadores ou URLs privadas. Exibe o motivo específico e a ação de registro quando falta a autorização. Não faz chamadas HTTP, não altera eventos e não cria registros financeiros.

As três autorizações posteriores são arquivos privados diferentes: `approval-CHECK_PAYMENT.json`, `approval-RECONCILE.json` e `approval-DELIVER.json`. O operador decide separadamente e digita **`AUTORIZO H4 CHECK_PAYMENT BRL 100 TENTATIVA EXISTENTE`**, ou a frase equivalente com `RECONCILE`/`DELIVER`. Esses registros exigem TTY, valem15minutos, usam criação exclusiva/sincronização em disco e nunca substituem um arquivo existente. Vinculam exclusivamente a tentativa já criada, BRL100, banco/finalidade/origem H4, credencial e hash do contexto financeiro completo. Reconciliação e entrega vinculam também o hash da prova independente armazenada. Não precisam nem fabricam uma certificação de mínimo para consultar uma cobrança existente. Nenhum registro executa a operação autorizada; a execução exige nova frase (`CHECK_PAYMENT H4 CREDITO 100 CENTAVOS`, ou equivalente da operação). Mudança de contexto/credencial/prova bloqueia; `Reconcile` só pode ser autorizado após consulta positiva e `Deliver` após PAGA/outbox única. A consulta mantém seu orçamento durável único: timeout, falha, reinício ou perda da resposta não autorizam repetição. Sem prova positiva, nenhuma reconciliação, outbox ou entrega é permitida.

Continuam pendentes para implantação: HTTPS público estável/proxy, autenticidade de webhook e contratos de recuperação externa de INCERTA, evidências de estorno/liquidação, consumidor operacional de produção, ensaio autorizado de backup real/restauração e revisão de migrations pendentes. O procedimento de backup e desligamento acima permanece aplicável. Nenhuma migration nova é necessária na Fase5B; as tabelas `demo_*` são fixtures privadas do schema de demonstração, não estruturas de produção.

