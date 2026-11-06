# Saas-Marmitaria

## InfinitePay MVP

Configure somente `INFINITEPAY_ENCRYPTION_KEY` (32 bytes aleatórios em Base64) além das variáveis gerais já existentes. Preserve essa chave entre deploys. Cadastre a InfiniteTag e a API Key pelo painel, salve e ative. A ativação fica no PostgreSQL até o proprietário desativá-la.

Execute `npx knex migrate:latest` antes de iniciar esta versão. A migration incremental preserva transações e credenciais existentes. As 13 migrations da branch anterior ficam arquivadas para validar o histórico de bancos que já as aplicaram; não são executadas em instalações novas. Nenhuma migration foi executada automaticamente no banco de produção.

A URL pública HTTPS do backend vem de `RENDER_EXTERNAL_URL`, fornecida pela Render. O retorno usa a primeira origem HTTPS de `ALLOWED_ORIGINS`. Nenhuma URL financeira usa headers do cliente. `assured_installments` configura taxas assumidas pelo vendedor, não o número máximo de parcelas.

Rotas:

- `GET/PUT /configuracoes/infinitepay`: consultar/salvar configuração.
- `PATCH /configuracoes/infinitepay/ativacao`: ativar/desativar permanentemente.
- `POST /pagamentos/checkout`: pedido existente no formato da aplicação e `client_request_id` UUID v4 estável.
- `GET /pagamentos/pedidos/:id`: status com token opaco do pedido no header Bearer.
- `POST /pagamentos/pedidos/:id/confirmar`: confirmação oficial usando os identificadores do retorno.
- `POST /pagamentos/webhook/infinitepay`: webhook; a URL anterior `/pagamentos/infinitepay/webhook` continua atendida.
- `GET /pagamentos/admin` e `POST /pagamentos/admin/:id/conciliar`: consulta e conciliação administrativas.

Escritas administrativas exigem o cookie autenticado, a permissão correspondente, origem permitida e `X-Infinitepay-CSRF`, obtido nas consultas administrativas. As quatro permissões são `pagamentos.configurar`, `pagamentos.ativar`, `pagamentos.visualizar` e `pagamentos.conciliar`.

Novas cobranças exigem integração ativa. Cobranças existentes usam sua credencial original mesmo após desativação. Somente `success: true`, `paid: true` e `amount` igual ao valor original liberam a cozinha. O pagamento e a liberação são gravados juntos; Socket.IO notifica após commit. A cozinha recarrega os pedidos elegíveis ao reconectar.

Cliques repetidos recuperam a mesma tentativa. Se a resposta da criação se perder, não há recriação automática: o painel permite conciliação e reenvio explícito do payload original. A InfinitePay não oferece consulta de link pelo `order_nsu` nem garantia formal de idempotência; confira a cobrança antes de repetir manualmente. O cliente pode abrir o link recuperado no acompanhamento. Pagamentos de pedidos cancelados ficam registrados sem iniciar produção; restaurar um pedido já pago requer confirmação oficial prévia.

Não há sandbox oficial. Esta entrega não executa pagamentos reais, deploy ou merge na `main`.

