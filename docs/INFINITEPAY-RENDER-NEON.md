# InfinitePay em produção — Render + Neon

Este guia corresponde à branch `feature/infinitepay-checkout`. Ele simplifica a configuração sem substituir autorização administrativa ou validações de pagamento.

## Configuração mínima no Render

Variáveis definidas manualmente:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://USUARIO:SENHA@HOST.neon.tech/BANCO?sslmode=require
FRONTEND_URL=https://seu-site.com.br
JWT_SECRET=<segredo-ja-existente-com-pelo-menos-32-caracteres>
INFINITEPAY_MODE=production
INFINITEPAY_DATABASE_ID=<uuid-existente-da-identidade-de-producao>
INFINITEPAY_ENCRYPTION_KEY=<chave-base64-de-32-bytes>
INFINITEPAY_ENABLED=false
```

**Não copie os valores de exemplo. Não commite segredos.** O Render fornece `NODE_ENV=production` em tempo de execução, mas esta aplicação roda migrações Knex durante o **build**, portanto configure `NODE_ENV=production` explicitamente no ambiente para aplicar as regras TLS de produção também no build. O Render fornece `RENDER=true`, `RENDER_SERVICE_TYPE=web` e `RENDER_EXTERNAL_URL` automaticamente. No Render, o backend escuta em `0.0.0.0`, e o modo de entrada HTTP utiliza somente o hop de proxy da plataforma. Assim, `INFINITEPAY_TRUSTED_PROXY_IPS` não é necessário **quando essas variáveis da plataforma estão presentes e válidas**. Em outras hospedagens, permanece obrigatório fornecer IPs confiáveis explicitamente.

O backend deriva, se não houver um valor explícito:
- `INFINITEPAY_DATABASE_NAME` da `DATABASE_URL`;
- `INFINITEPAY_PUBLIC_ORIGIN` da `RENDER_EXTERNAL_URL` (ou `BACKEND_URL`, para domínio próprio);
- `INFINITEPAY_SUCCESS_URL` de `FRONTEND_URL + /pedido/sucesso`;
- `ALLOWED_ORIGINS` de `FRONTEND_URL`;
- `INFINITEPAY_ALLOWED_PUBLIC_ORIGINS` das origens do backend e do frontend;
- `INFINITEPAY_BIND_HOST=0.0.0.0` no Render.

Se há mais de um frontend ou domínio personalizado, defina explicitamente as listas de origens. Nunca inclua `*` em origens autorizadas.

## Neon / verificação TLS

`DATABASE_URL` aceita as opções usuais `?sslmode=require` e `&channel_binding=require`. Na inicialização financeira o `knexfile.js` converte a URL em campos individuais e define `ssl.rejectUnauthorized=true`, evitando que o parser da biblioteca substitua essa verificação. `channel_binding=require` habilita o suporte do driver ao channel binding; verifique separadamente se o driver utilizado atende ao nível de garantia exigido na implantação. Não configure `sslmode=disable` ou `sslmode=no-verify`.

Se usar `DB_SSL_CA`, informe a cadeia CA confiável. Não configure `NODE_TLS_REJECT_UNAUTHORIZED=0`.

O banco deve conter a tabela `infinitepay_identidade_ambiente`, com `id=1`, `ambiente='PRODUCAO'` e `identidade` correspondente ao UUID definido em `INFINITEPAY_DATABASE_ID`. Não invente ou substitua essa identidade por um valor aleatório. Consulte, com conexão segura ao banco:

```sql
SELECT current_database();
SELECT id, ambiente, identidade FROM infinitepay_identidade_ambiente WHERE id = 1;
```

## Ativação administrativa e limitações atuais

1. Mantenha `INFINITEPAY_ENABLED=false` durante a verificação do ambiente e banco.
2. Cadastre InfiniteTag e API Key reais pela API administrativa `/configuracoes/infinitepay`, armazenando a chave criptografada (jamais no frontend ou nos logs).
3. Confira permissões administrativas, a credencial, os métodos PIX e cartão, o destino operacional, o retorno e o webhook, bem como os testes de idempotência e reconciliação.
4. Para habilitar a operação, o operador pode alterar `INFINITEPAY_ENABLED=true`. Esse sinalizador apenas disponibiliza os quatro controles existentes; ele **não autoriza** nenhuma cobrança. Um `false` explícito em qualquer controle granular prevalece; o sinalizador mestre em `false` desliga todos.
5. A autorização efetiva depende do painel de controle `/pagamentos/controle-producao` (permissão `pagamentos.ativar_producao` e CSRF). Aprovações estão vinculadas à sessão e ao processo e expiram em no máximo **15 minutos**, sem renovação automática. Reinicializações também invalidam autorizações. **Não considere o checkout apto a operar 24/7 sem um projeto separado de autorização operacional durável, testado e aprovado.**
6. Após qualquer mudança, valide `GET /health/ready`, autenticação, origem HTTPS, confirmação server-side, uma transação real controlada, webhooks, idempotência, outbox e recuperação após reinício.

## Testes rápidos

```bash
node --test tests/resolveFinancialEnvironment.test.js tests/postgresConnection.test.js tests/infinitepayRenderConfig.test.js
```

A suíte completa e os testes de integração PostgreSQL devem ser executados separadamente antes de liberar pagamentos reais. As refatorações acima não removem nenhuma validação da identidade de produção e não ampliam a duração das autorizações financeiras.
