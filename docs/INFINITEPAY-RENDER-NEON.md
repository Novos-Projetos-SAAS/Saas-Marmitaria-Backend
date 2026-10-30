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

## Testar localmente no Windows como produção (Neon + Vercel)

Este é um modo **explicitamente habilitado** de teste de implantação. O backend continua com
`NODE_ENV=production` e `INFINITEPAY_MODE=production`. O modo
`INFINITEPAY_LOCAL_TEST=true` dispensa apenas o proxy de entrada específico do
Render, exigindo que o processo escute exclusivamente em loopback e receba
requisições externas através de um túnel HTTPS local.

**Não existe uma forma de a Vercel atingir o Node local por meio da URL do Render.**
A URL do Render sempre envia requisições ao processo hospedado no Render. Para
testar o código Windows fim a fim, use um domínio de túnel HTTPS apontando para
`http://127.0.0.1:3333`. Não exponha a porta 3333 no roteador.

### 1. Túnel HTTPS local

Use um túnel HTTPS com hostname público, por exemplo Cloudflare Tunnel.
Uma alternativa temporária para desenvolvimento:

```powershell
cloudflared tunnel --url http://127.0.0.1:3333
```

O comando mostra uma URL `https://...trycloudflare.com`. Ela muda a cada
inicialização do túnel, portanto atualize a variável `BACKEND_URL` antes
de iniciar/reiniciar o backend. Um domínio fixo de túnel é preferível para
testes recorrentes de webhook/checkout.

### 2. Configure o arquivo .env local (não subir ao Git)

```dotenv
NODE_ENV=production
INFINITEPAY_MODE=production
INFINITEPAY_LOCAL_TEST=true
INFINITEPAY_BIND_HOST=127.0.0.1
DATABASE_URL=postgresql://USUARIO:SENHA@HOST-NEON/BANCO?sslmode=require
FRONTEND_URL=https://frontend-de-preview.vercel.app
BACKEND_URL=https://URL-DO-SEU-TUNEL.trycloudflare.com
JWT_SECRET=<mesmo-segredo-compatível-com-a-sessão-que-você-usa>
INFINITEPAY_DATABASE_ID=<uuid-existente-do-banco-selecionado>
INFINITEPAY_ENCRYPTION_KEY=<chave-base64-correspondente-às-credenciais>
INFINITEPAY_ENABLED=false
```

Remova do .env local as variáveis `RENDER`, `RENDER_EXTERNAL_URL`,
`INFINITEPAY_TRUSTED_PROXY_IPS` e qualquer
`INFINITEPAY_PUBLIC_ORIGIN` que ainda aponte para o Render.
`INFINITEPAY_ALLOWED_PUBLIC_ORIGINS` e `ALLOWED_ORIGINS` podem ser
omitidas para serem derivadas de `BACKEND_URL` e `FRONTEND_URL`; remova
valores antigos para evitar conflito.

Para executar o diagnóstico de configuração sem imprimir segredos:

```powershell
npm run diagnose:infinitepay:local
npm run diagnose:infinitepay:boot
npm run start
```

Se houver `INFINITEPAY_PRODUCTION_BLOCKED`, confira principalmente:
identidade do banco na tabela `infinitepay_identidade_ambiente`, domínio
HTTPS de túnel, domínio Vercel, TLS Neon, chaves do ambiente e ausência
das variáveis `RENDER*` copiadas da nuvem. O diagnóstico valida regras
de ambiente, não comprova conexão de banco ou autorização financeira.

### 3. Conectar o frontend

No ambiente **Preview** da Vercel, configure `NEXT_PUBLIC_API_URL` para
a URL HTTPS do túnel e faça novo build/deploy do frontend. O
`NEXT_PUBLIC_SITE_URL` deve ser o endereço correspondente da Preview.
Reutilizar um frontend cujo `NEXT_PUBLIC_API_URL` aponta para o Render
testa o backend do Render, **não** o Node que você está executando em casa.

A aplicação precisa enviar cookies com `Secure` e credenciais habilitadas,
e o backend precisa incluir a URL exata da Preview em `ALLOWED_ORIGINS`
(automaticamente se `FRONTEND_URL` estiver correto). Para chamadas de
webhook/retorno, o processo local deve permanecer ligado e o túnel ativo.

### 4. Pagamentos reais e isolamento

**Não utilize o mesmo banco Neon de produção simultaneamente em duas
instâncias com processamento financeiro habilitado** (Render e Windows).
Isso pode gerar competição entre workers, atualização de pedidos de
clientes reais, alterações de estado e callbacks direcionados ao servidor
errado. Prefira uma branch de banco isolada na Neon, com identidade
financeira válida e credenciais de teste controladas, mais uma implantação
Preview na Vercel.

`INFINITEPAY_ENABLED=false` mantém cobranças desativadas enquanto você
valida inicialização, migrações e conectividade. Alterar para `true`
ainda exige autorizações administrativas explícitas, que expiram em até
15 minutos, e pode movimentar dinheiro real. Não existe sandbox público
para usar uma API Key de produção da InfinitePay sem transações reais.

### Inicialização falhou apesar de PostgreSQL conectado

A mensagem `PostgreSQL conectado com Knex!` comprova apenas que o servidor
conseguiu executar `SELECT 1`. Não comprova identidade financeira, migrations,
schema, prontidão do worker ou proxy HTTPS. O servidor agora registra somente
a etapa e uma categoria de erro autorizada (sem mensagens de exceção que
possam conter credenciais).

Execute:

```powershell
git switch feature/infinitepay-checkout
git pull --ff-only
npm run diagnose:infinitepay:boot
```

O preflight acessa a Neon em modo **somente leitura** e identifica requisitos
de produção ausentes. Códigos comuns:

- `DB_IDENTITY_TABLE`: migration/provisionamento da identidade ausente;
- `DB_IDENTITY_ROW`: registro `id=1` inexistente;
- `DB_IDENTITY_PRODUCTION`: marcador não indica `PRODUCAO`;
- `DB_IDENTITY_MATCH`: UUID do .env diverge do UUID persistido no banco;
- `DB_TABLE_INFINITEPAY_ENTREGAS_OPERACIONAIS`, `DB_TABLE_INFINITEPAY_ENTREGAS_TENTATIVAS`:
  migrations/tabelas financeiras pendentes;
- `DB_MIGRATIONS_CURRENT`: há migrations no repositório não aplicadas;
- `DB_PRODUCTION_ASSERT`: o verificador financeiro ainda rejeita o banco.

Não insira registros de identidade aleatórios nem execute seeds de produção
para passar a validação. Resolva a causa específica antes de ligar o
checkout real. O diagnóstico **não imprime** valores de conexão/segredos
e não altera registros.

## A identidade do banco está em NAO_CONFIGURADO

A migration `20261027000200_infinitepay_identidade_ambiente.js` cria o registro
`id=1` com um UUID gerado pelo PostgreSQL e com
`ambiente='NAO_CONFIGURADO'`. A migração **não promove** o banco automaticamente
para produção. Se o preflight retorna `DB_IDENTITY_PRODUCTION` com falha e
`DB_IDENTITY_MATCH` com sucesso, a causa é a classificação do ambiente,
não a conexão nem o UUID.

Antes de qualquer mudança: confirme que está conectado ao banco/branch Neon
pretendido, que seu uso para **pagamentos reais** foi deliberadamente
autorizado, que há backup e que nenhum worker financeiro não testado
compartilha o banco. Nunca promova um banco de homologação ou a base de
clientes reais somente para eliminar uma mensagem de erro no Windows.

Consulta segura no SQL Editor da Neon:

```sql
SELECT current_database() AS banco, current_schema() AS schema;
SELECT id, ambiente, identidade
FROM infinitepay_identidade_ambiente
WHERE id = 1;
```

**Somente para uma implantação explicitamente destinada a produção**, com
resultado `ambiente='NAO_CONFIGURADO'`, uma classificação manual controlada
pode ser feita por operador autorizado:

```sql
BEGIN;
UPDATE infinitepay_identidade_ambiente
SET ambiente = 'PRODUCAO'
WHERE id = 1
  AND ambiente = 'NAO_CONFIGURADO'
RETURNING id, ambiente;
COMMIT;
```

Esperado: **uma linha** atualizada. Se retornar zero linhas, **não force**
um UPDATE de `HOMOLOGACAO` para `PRODUCAO` sem investigar a finalidade
do banco e a existência de transações anteriores. `COMMIT` apenas
persiste a classificação; não ativa pagamentos. Mantenha
`INFINITEPAY_ENABLED=false` até os demais requisitos estarem validados.

Reexecute `npm run diagnose:infinitepay:boot` e `npm start`. O modo local
com túnel HTTPS não altera o requisito de `ambiente='PRODUCAO'`.

## Seed isolada: promover usuário administrador e liberar acesso à InfinitePay

As migrations criam as permissões, mas **não** concedem automaticamente
`pagamentos.ativar_producao` a nenhuma pessoa. O comando abaixo promove
**somente o usuário explicitamente selecionado** para o nível `admin` e
adiciona permissões de gerenciamento RBAC e InfinitePay. **Não altera
senha, e-mail, dados de pedidos, estados financeiros ou credenciais**.

**Importante:** `npx knex seed:run` sem `--specific` executa seeds legadas
que apagam dados e redefinem senhas. Nunca execute esse comando completo
na Neon utilizada para pagamentos. As seeds destrutivas antigas agora
rejeitam perfis de produção, mas o comando permitido é **somente a seed
específica**.

1. Confirme manualmente no banco Neon que o usuário 1 corresponde à conta
   administradora pretendida, está ativo e não está excluído.
2. Use um terminal PowerShell na pasta do backend:
   ```powershell
   git switch feature/infinitepay-checkout
   git pull --ff-only

   $env:SEED_INFINITEPAY_ADMIN_USER_ID = "1"
   $env:SEED_INFINITEPAY_ADMIN_CONFIRM = "PROMOVER_USUARIO_1"
   $env:INFINITEPAY_ENABLED = "false"
   npm run seed:infinitepay:admin

   Remove-Item Env:SEED_INFINITEPAY_ADMIN_USER_ID -ErrorAction SilentlyContinue
   Remove-Item Env:SEED_INFINITEPAY_ADMIN_CONFIRM -ErrorAction SilentlyContinue
   Remove-Item Env:INFINITEPAY_ENABLED -ErrorAction SilentlyContinue
   ```
   A configuração `INFINITEPAY_ENABLED=false` acima vale somente para
   esse processo de seed. Não muda as configurações do Render ou as
   autorizações já ativas de outros processos conectados ao mesmo banco.
3. Confira o resultado sem listar segredos ou credenciais:
   ```sql
   SELECT u.id, u.nome, n.nome AS nivel_acesso, p.nome AS permissao
   FROM usuarios u
   JOIN niveis_acesso n ON n.id = u.nivel_acesso_id
   JOIN permissoes_usuarios pu ON pu.usuario_id = u.id
   JOIN permissoes p ON p.id = pu.permissao_id
   WHERE u.id = 1
     AND p.nome IN (
       'permissoes.listar', 'permissoes.visualizar', 'permissoes.editar',
       'pagamentos.configurar', 'pagamentos.visualizar',
       'pagamentos.conciliar', 'pagamentos.ativar_producao'
     )
   ORDER BY p.nome;
   ```
   Resultado esperado: as sete permissões acima com `nivel_acesso=admin`.
4. Faça logout e login novamente para atualizar o cargo contido no token.
   As permissões podem ser administradas em
   `/admin/usuarios/1/permissoes`. A concessão de permissões **não liga**
   a InfinitePay, não inicia o worker e não cria aprovações financeiras.

Se a seed falhar por falta de permissão no catálogo, confira as migrations
e não crie permissões manualmente por meio do frontend. Se o usuário não
existir, estiver inativo ou excluído, a seed interrompe sem modificá-lo.
