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
8. Produção permanece bloqueada no código desta fase. Antes de implantação comercial, definir e aprovar o modo de produção, banco/origens, proxy confiável, consumidor operacional e política de reprocessamento/reconciliação. Em qualquer incidente, desligar criação preservando credenciais, worker e evidências. Reverter Git não reverte o banco nem cancela links já criados.

