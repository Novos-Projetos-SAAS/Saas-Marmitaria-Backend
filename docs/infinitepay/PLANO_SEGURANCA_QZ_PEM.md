# Plano separado — segurança QZ e material privado

Fase 1.2, 23/10/2026. **Proposta, sem execução.** Esta fase não modifica o PEM, a assinatura QZ, o Frontend, estações ou regras de rede. Nenhuma chave ou credencial é reproduzida neste documento.

## Situação e risco

- `private-key.pem` continua rastreado no repositório. Não foi aberto nesta fase. Não está confirmado se corresponde à identidade ativa; remover apenas o arquivo atual não revoga cópias históricas.
- `src/controllers/Qz.Controller.js:72` usa `QZ_PRIVATE_KEY`, não lê esse arquivo diretamente. A equivalência entre arquivo, variável e certificado confiado deve ser verificada por operador autorizado, sem divulgar material privado.
- `src/routes/Qz.Routes.js:7` não exige autenticação. O assinador aceita material do chamador e seus logs/respostas de erro ainda podem expor detalhes (`Qz.Controller.js:88`, `:101`, `:106` e `:107`). O logger financeiro não cobre esses caminhos.
- Risco alto preexistente: uso indevido da identidade de assinatura e exposição de conteúdo. Não foi feita prova com chave real nem chamada ao assinador de produção.

## Contenção imediata proposta

Responsáveis: administrador da infraestrutura, responsável pela loja/impressão e mantenedor do Backend. As medidas abaixo exigem validação do ambiente e autorização operacional própria; não foram aplicadas automaticamente.

1. Suspender redistribuição do PEM, limitar acesso ao repositório/artefatos/backups e remover cópias públicas indevidas por processo controlado. Preservar evidência de exposição em local restrito, sem replicar a chave em chamados.
2. Inventariar chamadas legítimas a `/qz/assinar` e estações/origens. Se houver proxy/WAF/VPN, avaliar restrição temporária ao conjunto efetivamente necessário, com teste de uma estação piloto antes da mudança geral. Bloquear tráfego legítimo por IP móvel/proxy mal inventariado interromperia impressão; CORS ou ocultação da URL não são controles suficientes.
3. Restringir acesso e retenção dos logs existentes; verificar se contêm payloads ou erros sensíveis. Evitar ativar debug. Preparar remoção dos logs brutos em correção autorizada, preservando metadados úteis.
4. Confirmar identidade e validade usando certificado público/fingerprint e conferência segura pelo operador. Se o material exposto estiver ativo, tratar como comprometido e priorizar rotação coordenada. Não aguardar que apagar o arquivo do Git resolva a exposição.
5. Definir responsável de plantão, janela e caminho de contingência de impressão antes de qualquer bloqueio/revogação. Não manter chave comprometida como estratégia permanente de retorno.

## Correção de aplicação proposta

- Manter assinatura no servidor, com chave em secret manager/armazenamento restrito e acesso mínimo. Nunca mover a chave para o navegador, respostas HTTP, logs ou arquivos públicos.
- Exigir sessão válida, usuário/cargo ativo e permissão explícita para impressão; proteger chamadas do navegador com Origin exato e CSRF da sessão. Verificar como o cliente atual envia cookies antes de endurecer a rota.
- Autorizar operações QZ explicitamente e limitar tamanho/taxa. Vincular impressão/reimpressão ao trabalho permitido. Descoberta de impressoras e outras funções necessárias não devem exigir artificialmente um ID de pedido.
- Validar a operação sem alterar os bytes assinados, formato base64 de resposta ou algoritmo requerido pelas versões efetivamente instaladas. Evitar desserializar e reserializar a mensagem antes da assinatura.
- Retornar erros públicos fixos e registrar somente ação/resultado, usuário autorizado e identificador interno não sensível. Não registrar payload, chave, fragmento de assinatura, headers, query ou erro bruto.
- Definir replay/janela temporal de acordo com o protocolo real do cliente/QZ, sem inventar campos incompatíveis. Falha de autenticação deve impedir assinatura sem quebrar chamadas legítimas já homologadas.

## Rotação e limpeza do Git

1. Em homologação, emitir material de teste e provar correspondência certificado/chave sem divulgar a chave. Verificar versões QZ, certificado público usado pelos clientes, validade e confiança em cada estação.
2. Preparar novo par operacional por canal seguro, plano de distribuição do certificado público, atualização de confiança e implantação coordenada do servidor. Verificar possibilidade de transição suportada; não supor sobreposição de certificados/chaves.
3. Realizar piloto e observar impressão automática/manual e reimpressão. Em falha, usar a contingência acordada; não restaurar uma identidade sabidamente exposta sem decisão formal de incidente.
4. Após transição validada, revogar/desconfiar a identidade antiga conforme suporte e operação QZ. Remover material privado do HEAD e reforçar prevenção de reintrodução. Limpeza de histórico exige autorização específica, coordenação dos clones/backups e eventual reescrita de referências; está fora da Fase 1.2.
5. Guardar somente fingerprints públicos, datas e resultados de validação nos registros de mudança. Nenhum PEM privado ou variável secreta deve aparecer no diff, relatório ou chamado.

## Testes e critérios de aceite

| Área | Casos e evidência exigidos |
|---|---|
| Autorização | Sem sessão, expirada, usuário desativado e sem permissão: rejeitar sem assinatura. Usuário permitido: contrato atual preservado. |
| Escrita e abuso | Origin ausente/nulo/indevido, CSRF ausente/de outra sessão, operação desconhecida, payload excessivo e limite de taxa: rejeitar sem vazar conteúdo. |
| Protocolo | Assinatura de fixture sintética verificada com certificado público correspondente; qualquer alteração dos bytes falha. Mesma codificação e tipo de resposta do cliente atual. |
| Funções QZ | Conectar/reconectar, obter lista de impressoras, selecionar impressora, imprimir e reimprimir; confirmar quais funções realmente pedem assinatura. |
| Continuidade | Impressão automática habilitada/desabilitada, nome persistido, múltiplas estações/impressoras, fila, falha de rede e reinício do QZ/servidor. Comprovar ausência de perda e de duplicação de trabalhos no cenário de contingência acordado. |
| Certificado | Correspondência com chave, confiança/validade em cada versão instalada, piloto e transição/revogação. Não testar confiança com chave privada exposta em cliente. |
| Logs | Sentinelas sintéticas em payload/erro/query/headers não aparecem em resposta, console, auditoria ou proxy configurado. |

Os testes de roundtrip do cadastro nesta Fase 1.2 comprovam persistência das configurações de impressão no Backend. **Não comprovam impressão física, confiança de certificado ou segurança do assinador.** Todos os testes operacionais acima continuam pendentes.

Fonte oficial consultada em 23/10/2026: [QZ — Signing](https://qz.io/docs/signing). O QZ recomenda assinatura no servidor e separa os callbacks de certificado e assinatura; estes podem ser invocados por funções além da impressão. O roteiro deve ser adaptado às versões e chamadas reais da instalação.

## Levantamento de contratos — Fase 5D.2 (28/10/2026)

Somente leitura; nenhuma chave, certificado, assinatura ou funcionalidade de impressão foi alterada. O conteúdo do arquivo privado não foi aberto, copiado ou exibido.

- Backend `Pedidos.Controller.js:188-203`: o ramo InfinitePay retorna após persistência/reserva e não emite o aviso legado; o ramo posterior usa `emit('novo_pedido_recebido')` sem recibo durável do destinatário.
- Frontend `NotificationListener.jsx:25-43`: o Set de deduplicação é volátil, limitado e atualizado antes da tentativa. O fluxo aguarda imprimirCupom, mas não devolve confirmação autenticada/persistente ao Backend. Revalida elegibilidade financeira antes de imprimir; essa trava deve permanecer.
- Frontend `qzService.js:112-116`: aguarda qz.print e retorna true. A [API oficial](https://qz.io/api/qz) informa que o documento pode ter sido enviado sem impressão física concluída. Não foram encontrados callbacks de estado da impressora nesse serviço.
- A [documentação de estados](https://qz.io/docs/printer-status) descreve listeners e eventos originados de Winspool/CUPS. Sua existência não comprova confirmação física confiável em cada equipamento instalado. Precisariam de correlação persistente por trabalho, autenticação, idempotência e ensaio por versão/modelo; não estão homologados nesta fase.

Consequência: liberação lógica, tentativa de envio, recebimento verificável e impressão física são níveis distintos. O recibo do receptor sintético 5D.2 não comprova nenhum deles no QZ real. O destino operacional real permanece sem conexão; não se transforma promise, Socket.IO emitido ou sucesso local em recibo físico.

O risco potencial de produção continua alto: PEM rastreado, identidade ativa desconhecida e `/qz/assinar` sem autenticação local. O controlador usa `QZ_PRIVATE_KEY` e ainda registra request, fragmento de assinatura e erro livre (`Qz.Controller.js:73,88,101,106-107`). Não foi verificada correspondência entre variável, arquivo e certificado confiado.

O plano de contenção e rotação acima continua pendente de autorização própria: restringir distribuição/acesso e logs; inventariar chamadas legítimas; testar sessão, papel/permissão, Origin/CSRF e limitação de operações sem mudar bytes assinados; conferir identidade por fingerprints públicos em canal seguro; decidir rotação coordenada se a chave exposta estiver ativa, com piloto e contingência. Nenhuma restrição de rede, autenticação do assinador, revogação ou limpeza de histórico foi aplicada automaticamente. Não há certificação de segurança do QZ para produção nesta fase.

## Barreiras verificadas e exposição não comprovada — Fase 5D.3

Inspeção local somente de código e metadados Git, sem ler a chave privada nem consultar produção. `src/app.js:124` monta `/qz`; `src/routes/Qz.Routes.js:7` aceita POST `/assinar` sem JWT, usuário ativo, permissão ou CSRF. O CORS global (`app.js:60-78`) restringe origens do navegador, mas aceita requisições sem Origin e não autentica chamadas de clientes HTTP. Há parser JSON (`:80`) e rate limit geral (`:94`); limitar volume não impede assinatura indevida. No modo financeiro production, o guard de proxy (`:49`) valida o salto/origem de rede antes das rotas, mas não substitui autorização do assinador. Fora desse modo o código legado confia em um salto de proxy; nenhuma configuração operacional foi alterada.

Conclusão verificável: a rota está incluída na aplicação e não possui barreira de identidade própria. Sua acessibilidade externa efetiva depende de bind, hospedagem, proxy, firewall/VPN e regras de publicação; **não foi comprovada nem descartada**, porque produção não foi acessada. Antes de implantação, o responsável deverá fornecer configuração de exposição e realizar ensaio autorizado com cliente não autenticado/origem indevida, sem assinar material operacional. Não apresentar ausência de teste externo como prova de segurança.

Risco alto já demonstrado no código: material privado versionado e assinatura de material do chamador sem autorização. Se a chave rastreada for a identidade ativa e houver acesso por terceiros, tratar como incidente crítico de identidade: mensagens assinadas podem ser aceitas pelos clientes QZ que confiem nela, conforme versão, funções habilitadas e políticas locais. O alcance não pode ser inferido só pela existência do PEM. Uma chave de assinatura exposta não é automaticamente a API Key InfinitePay; os escopos e segredos são distintos.

Urgente, sob responsabilidade operacional: restringir distribuição e leitura dos artefatos/logs, identificar a exposição real do endpoint e inventariar estações legítimas. Qualquer alteração de WAF/rede precisa de piloto/contingência para preservar a impressão. Dependem de autorização própria: endurecer sessão/permissão/Origin/CSRF, remover logs livres, restringir operações, mover material privado para cofre e coordenar eventual rotação/limpeza Git. Não remover ou revogar antes de confirmar identidade e preparar transição segura. Os testes da matriz acima continuam necessários; nem autenticação do assinador nem impressão física foram ensaiadas nesta fase.

## Prioridade e evidências locais — Fase 5D.4

A inspeção preservou a chave sem leitura/cópia e conferiu somente metadados: o blob de `private-key.pem` continua igual ao da main. Isso comprova versionamento local, **não visibilidade pública do GitHub nem correspondência com a identidade ativa**. Não há nova evidência local suficiente para afirmar publicação pública, exploração, comprometimento ou exposição operacional ativa. Nenhuma sonda externa foi executada. O risco do assinador público independe de o PEM rastreado estar ativo: se o endpoint usa outra chave ativa e assina sem autorização para terceiros, a identidade pode ser abusada por esse caminho. Já a necessidade de revogar especificamente o PEM rastreado depende da correspondência e do acesso ao material.

Em `server.js:139`, os perfis financeiros explícitos usam bind loopback; fora deles o listen legado não fixa host. Loopback não impede publicação por proxy; bind sem host também não comprova exposição pela hospedagem. Não foram encontrados manifests locais de proxy/deploy que comprovem uma barreira externa efetiva. CORS, parser e rate limit já identificados não resolvem autorização. Manter risco alto e bloquear certificação/ativação até confirmar identidade e exposição; evidência futura de chave ativa exposta ou assinador operacional abusável exige classificação crítica e contenção de incidente antes de qualquer ativação comercial.

Prioridade sem mudança de protocolo de impressão: conter redistribuição/acesso aos repositórios, artefatos, backups e logs; inventariar estações, origens e responsáveis; conferir fingerprints públicos e configuração de publicação por canal seguro. São ações propostas ao operador, não aplicadas nesta fase. Restringir rede/repositório pode afetar equipes/estações e exige autorização e inventário; não presumir que seja uma mudança sem impacto.

Mudanças de aplicação e identidade exigem autorização específica e piloto: autenticação/permissão/CSRF/Origin do assinador, remoção de logs livres, allowlist das operações efetivamente utilizadas, cofre e eventual rotação coordenada com confiança dos certificados em cada estação. Preservar bytes/algoritmo/formato de assinatura, descoberta de impressoras e caminhos manual/automático/reimpressão. Medidas de contenção de acesso/logs podem preservar o protocolo existente, mas não são justificativa para trocar certificados ou bloquear tráfego legítimo sem teste. O plano e a matriz anteriores continuam válidos; nenhuma alteração QZ/PEM/assinador, limpeza Git ou impressão física foi realizada.
