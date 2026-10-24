# Bruno — InfinitePay / SaaS Marmitaria

Coleção de testes HTTP **para desenvolvimento local** na branch `feature/infinitepay-checkout`. Não altera código do servidor, schema ou credenciais. Compatível com arquivos `.bru` do Bruno (inclusive extensão para VS Code).

## Antes de executar (PowerShell / VS Code)

1. Abra o repositório `Saas-Marmitaria-Backend` e confira `git branch --show-current`: deve ser `feature/infinitepay-checkout`.
2. Prepare **um banco local descartável**, as configurações `.env` e as migrations necessárias **somente nesse banco**. Não reutilize `DATABASE_URL` de produção ou ambiente compartilhado.
3. Inicie a API nessa branch com `npm ci` e `npm run dev`. Porta padrão: `3333`. A rota `GET /keep-alive` não depende de sessão.
4. Copie o exemplo para um arquivo **não rastreado**:

   ```powershell
   Copy-Item .\bruno\infinitepay\environments\local.example.bru .\bruno\infinitepay\environments\local.bru
   ```

5. Edite **apenas** `local.bru`: `baseUrl` (ex.: `http://127.0.0.1:3333`), `allowedOrigin` (deve coincidir **exatamente** com um valor em `ALLOWED_ORIGINS` do backend), `loginEmail` e `loginSenha` de um **administrador de teste**. Nunca insira credenciais reais no arquivo `local.example.bru`.
6. Na extensão Bruno, selecione **Open Collection** e abra `bruno/infinitepay` (a pasta com `bruno.json`), depois selecione o ambiente **local**.
7. Execute por ordem: `01 - Diagnostico`, `02 - Administracao`, `03 - Financeiro inativo`. Para testes administrativos, execute primeiro o **login**, depois o **GET de configuração**, que captura o CSRF. A sessão e o CSRF são variáveis temporárias do Bruno, não arquivos do Git.

## O que cada grupo prova

| Pasta | Resultado esperado | Efeito |
| --- | --- | --- |
| `01 - Diagnostico` | Keep Alive 200; configuração sem token 401 | Apenas leitura |
| `02 - Administracao` | Login 200; configuração GET 200; rejeições 403, 400 e 415 | Login grava auditoria; testes PUT são **negativos** e não devem modificar configuração |
| `03 - Financeiro inativo` | Consulta, retomada, webhook vazio e retorno: 503 | Nenhuma cobrança; apenas verifica bloqueio do runtime não conectado |

O `POST /auth/login` responde com um cookie HTTPOnly `token`. O script do login captura o valor do cabeçalho `Set-Cookie` **em memória** para usar como `Cookie` nos requests administrativos seguintes. O GET de configuração guarda o `csrf_token` também em memória. Se o Bruno for reiniciado, repita login e GET.

## Limites — não confundir 503 com pagamento testado

Nesta branch o `src/server.js` não registra `app.locals.infinitepayRuntime`. As rotas financeiras em `/pagamentos` existem no Express, mas são **bloqueadas com HTTP 503** mesmo que uma variável de ambiente seja mudada. Os testes de sucesso financeiro do repositório dependem de adaptadores simulados e PostgreSQL sintético (`tests/integration/infinitepayHttp.test.js`); não há transporte de produção/homologação ativado aqui.

- **Não** use a coleção com uma URL de produção; o login gera auditoria e o servidor pode mudar futuramente.
- O request de webhook envia `{}`, **nunca** um evento falso de aprovação `paid`.
- A coleção **não** faz criação de pedidos, cobrança, estorno, liberação de cozinha, impressão nem migrações.
- Um teste falhar com `401` após o login pode indicar credencial incorreta, cookie ausente ou sessão vencida; `403` no GET pode significar ausência da permissão `pagamentos.configurar`.
- As asserções de `503` deixarão de ser válidas quando a integração real for conectada: reveja esses testes **antes** de ativar o runtime.

## Segurança local

`environments/local.bru` e qualquer outro arquivo `.bru` criado dentro de `environments/` (exceto `local.example.bru`) estão ignorados pelo Git. Não faça capturas de tela com a senha, tokens, cookies ou chave InfinitePay. O login e o CSRF permanecem apenas no escopo de execução do Bruno.

## Fontes no backend

- `src/app.js`, `src/server.js`
- `src/routes/Autenticacao.Routes.js`
- `src/routes/InfinitepayConfig.Routes.js`
- `src/routes/Pagamentos.Routes.js`
- `src/infinitepayRuntime.js`
- `tests/integration/infinitepayConfig.test.js`
- `tests/integration/infinitepayHttp.test.js`

A coleção foi estruturada a partir desses contratos de código; executar as chamadas **contra a API local** continua sendo a validação final do ambiente.
