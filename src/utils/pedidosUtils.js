// import connection from "../database/connection.js";
// import { lancarErro } from "./errorUtils.js";


// /**
//  * Converte um valor monetário para centavos.
//  *
//  * Mantemos os cálculos financeiros em inteiros para evitar
//  * problemas de ponto flutuante do JavaScript.
//  *
//  * Exemplo:
//  *
//  * 6.50 -> 650
//  */
// export function paraCentavos(valor) {
//     return Math.round(Number(valor) * 100);
// }


// /**
//  * Converte centavos novamente para decimal.
//  *
//  * Exemplo:
//  *
//  * 650 -> 6.50
//  */
// export function deCentavos(valor) {
//     return Number(
//         (valor / 100).toFixed(2)
//     );
// }


// /**
//  * Remove caracteres que não sejam números
//  * e valida um telefone com DDD.
//  */
// export function normalizarTelefone(telefone) {

//     const telefoneLimpo =
//         String(telefone || '')
//             .replace(/\D/g, '');


//     if (
//         telefoneLimpo.length < 10 ||
//         telefoneLimpo.length > 11
//     ) {

//         lancarErro(
//             'Telefone inválido. O telefone deve ter 10 ou 11 dígitos numéricos.',
//             400
//         );
//     }


//     return telefoneLimpo;
// }


// /**
//  * Garante que quantidades sejam números inteiros
//  * maiores que zero.
//  */
// function validarQuantidade(
//     quantidade,
//     tipoItem
// ) {

//     const valor =
//         Number(quantidade);


//     if (
//         !Number.isInteger(valor) ||
//         valor <= 0
//     ) {

//         lancarErro(
//             `A quantidade de ${tipoItem} deve ser um número inteiro maior que zero.`,
//             400
//         );
//     }


//     return valor;
// }


// /**
//  * ============================================================
//  * VALIDAÇÃO DOS ALIMENTOS DA MARMITA
//  * ============================================================
//  *
//  * Verifica:
//  *
//  * - se alimentos foram enviados;
//  * - IDs válidos;
//  * - alimento duplicado;
//  * - disponibilidade;
//  * - soft delete;
//  * - categoria ativa;
//  * - limite de escolhas por categoria.
//  */
// async function validarAlimentosDaMarmita(
//     alimentos,
//     trx
// ) {

//     if (
//         !Array.isArray(alimentos) ||
//         alimentos.length === 0
//     ) {

//         lancarErro(
//             'A marmita deve possuir pelo menos um alimento.',
//             400
//         );
//     }


//     const alimentosIds =
//         alimentos.map(
//             (id) => Number(id)
//         );


//     if (
//         alimentosIds.some(
//             (id) =>
//                 !Number.isInteger(id) ||
//                 id <= 0
//         )
//     ) {

//         lancarErro(
//             'A marmita possui um alimento inválido.',
//             400
//         );
//     }


//     /**
//      * Impede enviar o mesmo alimento duas vezes
//      * para tentar manipular limites.
//      */
//     if (
//         new Set(alimentosIds).size !==
//         alimentosIds.length
//     ) {

//         lancarErro(
//             'A marmita possui alimentos duplicados.',
//             400
//         );
//     }


//     const dadosAlimentos =
//         await connection('alimentos as a')

//             .transacting(trx)

//             .join(
//                 'categorias_alimentos as ca',
//                 'a.categoria_id',
//                 '=',
//                 'ca.id'
//             )

//             .select(
//                 'a.id',
//                 'a.categoria_id',
//                 'ca.nome as categoria_nome',
//                 'ca.limite_escolhas'
//             )

//             .whereIn(
//                 'a.id',
//                 alimentosIds
//             )

//             .where(
//                 'a.disponivel_hoje',
//                 true
//             )

//             .whereNull(
//                 'a.deletado_em'
//             )

//             .where(
//                 'ca.ativo',
//                 true
//             )

//             .whereNull(
//                 'ca.deletado_em'
//             );


//     /**
//      * Se retornou menos alimentos do que foi enviado,
//      * algum deles não existe ou está indisponível.
//      */
//     if (
//         dadosAlimentos.length !==
//         alimentosIds.length
//     ) {

//         lancarErro(
//             'Um ou mais alimentos selecionados estão indisponíveis.',
//             400
//         );
//     }


//     const contagemPorCategoria = {};


//     for (
//         const alimento of dadosAlimentos
//     ) {

//         if (
//             !contagemPorCategoria[
//             alimento.categoria_id
//             ]
//         ) {

//             contagemPorCategoria[
//                 alimento.categoria_id
//             ] = {

//                 quantidade: 0,

//                 limite:
//                     Number(
//                         alimento.limite_escolhas
//                     ),

//                 nome:
//                     alimento.categoria_nome
//             };
//         }


//         contagemPorCategoria[
//             alimento.categoria_id
//         ].quantidade += 1;
//     }


//     /**
//      * Confere os limites.
//      *
//      * Exemplo:
//      * Proteínas = máximo 2.
//      */
//     for (
//         const categoria of
//         Object.values(
//             contagemPorCategoria
//         )
//     ) {

//         if (
//             categoria.quantidade >
//             categoria.limite
//         ) {

//             lancarErro(
//                 `Limite excedido na categoria ${categoria.nome}. ` +
//                 `Máximo: ${categoria.limite}, enviado: ${categoria.quantidade}.`,
//                 400
//             );
//         }
//     }


//     return alimentosIds;
// }


// /**
//  * ============================================================
//  * INSERIR MARMITAS
//  * ============================================================
//  *
//  * O preço NUNCA vem do frontend.
//  *
//  * É sempre utilizado:
//  *
//  * tamanhos_marmitas.preco_base
//  *
//  * @returns total das marmitas em centavos
//  */
// export async function inserirMarmitasPedido({
//     pedidoId,
//     marmitas,
//     trx
// }) {

//     let totalCentavos = 0;


//     for (
//         const marmita of marmitas
//     ) {

//         const tamanhoId =
//             Number(
//                 marmita?.tamanho_id
//             );


//         const quantidade =
//             validarQuantidade(
//                 marmita?.quantidade,
//                 'marmitas'
//             );


//         if (
//             !Number.isInteger(tamanhoId) ||
//             tamanhoId <= 0
//         ) {

//             lancarErro(
//                 'O tamanho da marmita informado é inválido.',
//                 400
//             );
//         }


//         /**
//          * Busca o preço verdadeiro do tamanho.
//          *
//          * forShare impede que o registro seja alterado
//          * enquanto estamos utilizando seu preço dentro
//          * desta transaction.
//          */
//         const tamanho =
//             await connection(
//                 'tamanhos_marmitas'
//             )

//                 .transacting(trx)

//                 .where({
//                     id: tamanhoId,
//                     ativo: true
//                 })

//                 .whereNull(
//                     'deletado_em'
//                 )

//                 .forShare()

//                 .first();


//         if (!tamanho) {

//             lancarErro(
//                 `Tamanho de marmita ID ${tamanhoId} não está disponível.`,
//                 400
//             );
//         }


//         const alimentosIds =
//             await validarAlimentosDaMarmita(
//                 marmita?.alimentos,
//                 trx
//             );


//         /**
//          * Trabalhamos em centavos.
//          */
//         const precoUnitarioCentavos =
//             paraCentavos(
//                 tamanho.preco_base
//             );


//         const subtotalCentavos =
//             precoUnitarioCentavos *
//             quantidade;


//         /**
//          * Item do tipo MARMITA:
//          *
//          * tamanho_marmita_id preenchido
//          * produto_id NULL
//          */
//         const [
//             itemPedido
//         ] =
//             await connection(
//                 'itens_pedido'
//             )

//                 .transacting(trx)

//                 .insert({

//                     pedido_id:
//                         pedidoId,

//                     tamanho_marmita_id:
//                         tamanhoId,

//                     produto_id:
//                         null,

//                     quantidade,

//                     preco_unitario:
//                         deCentavos(
//                             precoUnitarioCentavos
//                         ),

//                     subtotal:
//                         deCentavos(
//                             subtotalCentavos
//                         )
//                 })

//                 .returning([
//                     'id'
//                 ]);


//         /**
//          * Salva os alimentos pertencentes
//          * àquela marmita.
//          */
//         const composicao =
//             alimentosIds.map(
//                 (alimentoId) => ({

//                     item_pedido_id:
//                         itemPedido.id,

//                     alimento_id:
//                         alimentoId
//                 })
//             );


//         await connection(
//             'composicao_item_pedido'
//         )

//             .transacting(trx)

//             .insert(
//                 composicao
//             );


//         totalCentavos +=
//             subtotalCentavos;
//     }


//     return totalCentavos;
// }


// /**
//  * ============================================================
//  * AGRUPAR PRODUTOS
//  * ============================================================
//  *
//  * Se por algum motivo o frontend enviar:
//  *
//  * Coca x1
//  * Coca x2
//  *
//  * armazenamos:
//  *
//  * Coca x3
//  */
// function agruparProdutos(produtos) {

//     const produtosAgrupados =
//         new Map();


//     for (
//         const item of produtos
//     ) {

//         const produtoId =
//             Number(
//                 item?.produto_id
//             );


//         const quantidade =
//             validarQuantidade(
//                 item?.quantidade,
//                 'produtos'
//             );


//         if (
//             !Number.isInteger(produtoId) ||
//             produtoId <= 0
//         ) {

//             lancarErro(
//                 'O pedido possui um produto inválido.',
//                 400
//             );
//         }


//         produtosAgrupados.set(

//             produtoId,

//             (
//                 produtosAgrupados.get(
//                     produtoId
//                 ) || 0
//             ) + quantidade
//         );
//     }


//     return Array.from(

//         produtosAgrupados,

//         (
//             [
//                 produto_id,
//                 quantidade
//             ]
//         ) => ({

//             produto_id,

//             quantidade
//         })
//     );
// }


// /**
//  * ============================================================
//  * INSERIR PRODUTOS
//  * ============================================================
//  *
//  * Para ser vendido o produto precisa:
//  *
//  * - existir;
//  * - estar ativo;
//  * - estar disponível hoje;
//  * - não possuir soft delete;
//  * - categoria ativa;
//  * - categoria não excluída.
//  *
//  * O preço vem EXCLUSIVAMENTE de:
//  *
//  * produtos.preco
//  *
//  * @returns total dos produtos em centavos
//  */
// export async function inserirProdutosPedido({
//     pedidoId,
//     produtos,
//     trx
// }) {

//     if (
//         produtos.length === 0
//     ) {

//         return 0;
//     }


//     const produtosAgrupados =
//         agruparProdutos(
//             produtos
//         );


//     const produtosIds =
//         produtosAgrupados.map(
//             (item) =>
//                 item.produto_id
//         );


//     /**
//      * Busca todos de uma única vez.
//      *
//      * Isso é melhor do que executar uma query
//      * separada para cada produto.
//      */
//     const produtosBanco =
//         await connection(
//             'produtos as p'
//         )

//             .transacting(trx)

//             .join(
//                 'categorias_produtos as cp',
//                 'p.categoria_produto_id',
//                 '=',
//                 'cp.id'
//             )

//             .select(
//                 'p.id',
//                 'p.nome',
//                 'p.preco'
//             )

//             .whereIn(
//                 'p.id',
//                 produtosIds
//             )

//             .where(
//                 'p.ativo',
//                 true
//             )

//             .where(
//                 'p.disponivel_hoje',
//                 true
//             )

//             .whereNull(
//                 'p.deletado_em'
//             )

//             .where(
//                 'cp.ativo',
//                 true
//             )

//             .whereNull(
//                 'cp.deletado_em'
//             )

//             .forShare();


//     /**
//      * Se não encontramos todos, existe produto inválido,
//      * removido ou indisponível.
//      */
//     if (
//         produtosBanco.length !==
//         produtosIds.length
//     ) {

//         lancarErro(
//             'Um ou mais produtos selecionados estão indisponíveis.',
//             400
//         );
//     }


//     const produtosPorId =
//         new Map(

//             produtosBanco.map(
//                 (produto) => [

//                     Number(
//                         produto.id
//                     ),

//                     produto
//                 ]
//             )
//         );


//     let totalCentavos = 0;


//     for (
//         const item of produtosAgrupados
//     ) {

//         const produto =
//             produtosPorId.get(
//                 item.produto_id
//             );


//         const precoUnitarioCentavos =
//             paraCentavos(
//                 produto.preco
//             );


//         const subtotalCentavos =
//             precoUnitarioCentavos *
//             item.quantidade;


//         /**
//          * Item do tipo PRODUTO:
//          *
//          * tamanho_marmita_id NULL
//          * produto_id preenchido
//          */
//         await connection(
//             'itens_pedido'
//         )

//             .transacting(trx)

//             .insert({

//                 pedido_id:
//                     pedidoId,

//                 tamanho_marmita_id:
//                     null,

//                 produto_id:
//                     produto.id,

//                 quantidade:
//                     item.quantidade,

//                 preco_unitario:
//                     deCentavos(
//                         precoUnitarioCentavos
//                     ),

//                 subtotal:
//                     deCentavos(
//                         subtotalCentavos
//                     )
//             });


//         totalCentavos +=
//             subtotalCentavos;
//     }


//     return totalCentavos;
// }


// /**
//  * ============================================================
//  * RECALCULAR TOTAL
//  * ============================================================
//  *
//  * Utilizado principalmente durante edição.
//  */
// export async function calcularTotalPedido(
//     pedidoId,
//     trx
// ) {

//     const itens =
//         await connection(
//             'itens_pedido'
//         )

//             .transacting(trx)

//             .where(
//                 'pedido_id',
//                 pedidoId
//             )

//             .select(
//                 'subtotal'
//             );


//     return itens.reduce(

//         (total, item) =>

//             total +
//             paraCentavos(
//                 item.subtotal
//             ),

//         0
//     );
// }


// /**
//  * ============================================================
//  * JSON DAS MARMITAS
//  * ============================================================
//  *
//  * Será reutilizado por:
//  *
//  * - painel administrativo;
//  * - rastreio;
//  * - socket;
//  * - edição.
//  */
// export function selecionarMarmitasJson() {

//     return connection.raw(`
//         COALESCE(
//             (
//                 SELECT json_agg(
//                     item
//                     ORDER BY item.id
//                 )

//                 FROM (
//                     SELECT
//                         ip.id,

//                         ip.tamanho_marmita_id,

//                         tm.nome AS tamanho,

//                         ip.quantidade,

//                         ip.preco_unitario,

//                         ip.subtotal,

//                         COALESCE(
//                             (
//                                 SELECT json_agg(
//                                     json_build_object(
//                                         'id',
//                                         a.id,

//                                         'nome',
//                                         a.nome
//                                     )

//                                     ORDER BY
//                                         cip.id
//                                 )

//                                 FROM
//                                     composicao_item_pedido
//                                     AS cip

//                                 JOIN
//                                     alimentos AS a

//                                     ON
//                                     a.id =
//                                     cip.alimento_id

//                                 WHERE
//                                     cip.item_pedido_id =
//                                     ip.id
//                             ),

//                             '[]'::json
//                         ) AS alimentos

//                     FROM
//                         itens_pedido AS ip

//                     JOIN
//                         tamanhos_marmitas AS tm

//                         ON
//                         tm.id =
//                         ip.tamanho_marmita_id

//                     WHERE
//                         ip.pedido_id =
//                         pedidos.id

//                     AND
//                         ip.tamanho_marmita_id
//                         IS NOT NULL

//                     AND
//                         ip.produto_id
//                         IS NULL
//                 ) AS item
//             ),

//             '[]'::json
//         ) AS marmitas
//     `);
// }


// /**
//  * ============================================================
//  * JSON DOS PRODUTOS
//  * ============================================================
//  *
//  * Preço e subtotal vêm de itens_pedido.
//  *
//  * Portanto, mesmo que o preço atual do produto mude,
//  * o pedido antigo continua com o preço cobrado anteriormente.
//  */
// export function selecionarProdutosJson() {

//     return connection.raw(`
//         COALESCE(
//             (
//                 SELECT json_agg(
//                     item
//                     ORDER BY item.id
//                 )

//                 FROM (
//                     SELECT
//                         ip.id,

//                         ip.produto_id,

//                         p.nome,

//                         p.descricao,

//                         p.categoria_produto_id
//                             AS categoria_id,

//                         cp.nome
//                             AS categoria_nome,

//                         ip.quantidade,

//                         ip.preco_unitario,

//                         ip.subtotal

//                     FROM
//                         itens_pedido AS ip

//                     JOIN
//                         produtos AS p

//                         ON
//                         p.id =
//                         ip.produto_id

//                     JOIN
//                         categorias_produtos AS cp

//                         ON
//                         cp.id =
//                         p.categoria_produto_id

//                     WHERE
//                         ip.pedido_id =
//                         pedidos.id

//                     AND
//                         ip.produto_id
//                         IS NOT NULL

//                     AND
//                         ip.tamanho_marmita_id
//                         IS NULL
//                 ) AS item
//             ),

//             '[]'::json
//         ) AS produtos
//     `);
// }


// /**
//  * ============================================================
//  * PEDIDO COMPLETO
//  * ============================================================
//  *
//  * Usado principalmente depois da criação/edição
//  * e pelo Socket.IO.
//  */
// export async function buscarPedidoCompletoPorId(
//     pedidoId
// ) {

//     return connection('pedidos')

//         .leftJoin(
//             'metodos_pagamento',
//             'pedidos.metodo_pagamento_id',
//             '=',
//             'metodos_pagamento.id'
//         )

//         .select(

//             'pedidos.*',

//             'metodos_pagamento.nome as metodo_pagamento_nome',

//             selecionarMarmitasJson(),

//             selecionarProdutosJson()
//         )

//         .where(
//             'pedidos.id',
//             pedidoId
//         )

//         .first();
// }

// /**
//  * ============================================================
//  * VALIDAR STATUS DA LOJA
//  * ============================================================
//  *
//  * Essa validação é utilizada para pedidos públicos.
//  *
//  * Não podemos depender apenas do Frontend, porque
//  * alguém poderia chamar POST /pedidos diretamente.
//  */
// export async function validarLojaAberta(
//     trx
// ) {

//     const status =
//         await connection(
//             'status_loja'
//         )

//             .transacting(trx)

//             .where({
//                 id: 1
//             })

//             .first();


//     if (!status) {

//         lancarErro(
//             'Configuração da loja não encontrada.',
//             500
//         );
//     }


//     if (
//         status.esta_aberta !==
//         true
//     ) {

//         lancarErro(
//             'A loja está fechada no momento e não está recebendo novos pedidos.',
//             409
//         );
//     }


//     return true;
// }


// /**
//  * ============================================================
//  * VALIDAR MÉTODO DE PAGAMENTO
//  * ============================================================
//  *
//  * Impede que alguém envie manualmente o ID de um
//  * método de pagamento que esteja inativo.
//  */
// export async function validarMetodoPagamento(
//     metodoPagamentoId,
//     trx
// ) {

//     const id =
//         Number(
//             metodoPagamentoId
//         );


//     if (
//         !Number.isInteger(id) ||
//         id <= 0
//     ) {

//         lancarErro(
//             'Selecione um método de pagamento válido.',
//             400
//         );
//     }


//     const metodo =
//         await connection(
//             'metodos_pagamento'
//         )

//             .transacting(trx)

//             .where({
//                 id,
//                 ativo: true
//             })

//             .first();


//     if (!metodo) {

//         lancarErro(
//             'O método de pagamento selecionado não está disponível.',
//             400
//         );
//     }


//     return metodo;
// }

import connection from "../database/connection.js";
import { lancarErro } from "./errorUtils.js";

/**
 * Converte um valor monetário para centavos.
 * Mantemos os cálculos financeiros em inteiros para evitar
 * problemas de ponto flutuante do JavaScript.
 * Exemplo: 6.50 -> 650
 */
export function paraCentavos(valor) {
    const numero = Number(valor);

    if (!Number.isFinite(numero) || numero < 0) {
        lancarErro('Valor monetário inválido.', 500);
    }

    return Math.round(numero * 100);
}

/**
 * Converte centavos novamente para decimal.
 * Exemplo: 650 -> 6.50
 */
export function deCentavos(valor) {
    const numero = Number(valor);

    if (!Number.isFinite(numero) || numero < 0) {
        lancarErro('Valor em centavos inválido.', 500);
    }

    return Number((numero / 100).toFixed(2));
}

/**
 * Remove caracteres que não sejam números
 * e valida um telefone com DDD.
 */
export function normalizarTelefone(telefone) {
    const telefoneLimpo = String(telefone || '').replace(/\D/g, '');

    if (telefoneLimpo.length < 10 || telefoneLimpo.length > 11) {
        lancarErro('Telefone inválido. O telefone deve ter 10 ou 11 dígitos numéricos.', 400);
    }

    return telefoneLimpo;
}

/**
 * Garante que quantidades sejam números inteiros maiores que zero.
 */
function validarQuantidade(quantidade, tipoItem) {
    const valor = Number(quantidade);

    if (!Number.isInteger(valor) || valor <= 0) {
        lancarErro(`A quantidade de ${tipoItem} deve ser um número inteiro maior que zero.`, 400);
    }

    return valor;
}

/**
 * Normaliza e limita a observação individual da marmita.
 */
function normalizarObservacaoMarmita(observacao) {
    if (observacao === null || observacao === undefined) return null;

    const valor = String(observacao).trim();

    if (!valor) return null;

    if (valor.length > 60) {
        lancarErro('A observação da marmita deve possuir no máximo 60 caracteres.', 400);
    }

    return valor;
}

/**
 * Cria um conflito estruturado para o Frontend informar exatamente
 * quais alimentos ficaram indisponíveis antes da finalização.
 */
function lancarErroAlimentosIndisponiveis(marmitas) {
    const error = new Error('Um ou mais alimentos da sua marmita ficaram indisponíveis enquanto você fazia o pedido. Atualize ou remova a marmita para continuar.');
    error.statusCode = 409;
    error.code = 'ALIMENTOS_INDISPONIVEIS';
    error.details = { marmitas };
    error.exposeDetails = true;
    throw error;
}

/**
 * Informa ao Frontend quando algum produto do carrinho sofreu
 * alteração de disponibilidade ou preço antes da finalização.
 */
function lancarErroProdutosAlterados(produtos) {
    const error = new Error('Um ou mais complementos do seu pedido foram alterados enquanto você fazia o pedido. Revise as alterações para continuar.');
    error.statusCode = 409;
    error.code = 'PRODUTOS_ALTERADOS';
    error.details = { produtos };
    error.exposeDetails = true;
    throw error;
}

/**
 * Informa ao Frontend quando uma marmita especial ficou indisponível
 * ou teve o preço alterado antes da finalização.
 */
function lancarErroMarmitasEspeciaisAlteradas(marmitasEspeciais) {
    const error = new Error('Uma ou mais marmitas especiais do seu pedido foram alteradas enquanto você fazia o pedido. Revise as alterações para continuar.');
    error.statusCode = 409;
    error.code = 'MARMITAS_ESPECIAIS_ALTERADAS';
    error.details = { marmitas_especiais: marmitasEspeciais };
    error.exposeDetails = true;
    throw error;
}

/**
 * ============================================================
 * VALIDAÇÃO DOS ALIMENTOS DA MARMITA
 * ============================================================
 */
async function validarAlimentosDaMarmita(alimentos, trx) {
    if (!Array.isArray(alimentos) || alimentos.length === 0) {
        lancarErro('A marmita deve possuir pelo menos um alimento.', 400);
    }

    const alimentosIds = alimentos.map((id) => Number(id));

    if (alimentosIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        lancarErro('A marmita possui um alimento inválido.', 400);
    }

    if (new Set(alimentosIds).size !== alimentosIds.length) {
        lancarErro('A marmita possui alimentos duplicados.', 400);
    }

    // Busca também os itens que foram inativados depois da montagem para conseguirmos informar o motivo ao cliente.
    const dadosSolicitados = await connection('alimentos as a')
        .transacting(trx)
        .leftJoin('categorias_alimentos as ca', 'a.categoria_id', '=', 'ca.id')
        .select(
            'a.id',
            'a.nome',
            'a.categoria_id',
            'a.disponivel_hoje',
            'a.deletado_em',
            'ca.id as categoria_encontrada_id',
            'ca.nome as categoria_nome',
            'ca.ativo as categoria_ativa',
            'ca.deletado_em as categoria_deletada_em',
            'ca.limite_escolhas'
        )
        .whereIn('a.id', alimentosIds);

    const alimentosPorId = new Map(dadosSolicitados.map((alimento) => [Number(alimento.id), alimento]));
    const indisponiveis = [];

    for (const alimentoId of alimentosIds) {
        const alimento = alimentosPorId.get(alimentoId);

        if (!alimento) {
            indisponiveis.push({ id: alimentoId, nome: null, motivo: 'O alimento não existe mais no cardápio.' });
            continue;
        }

        if (alimento.deletado_em) {
            indisponiveis.push({ id: alimentoId, nome: alimento.nome, motivo: 'O alimento foi removido do cardápio.' });
            continue;
        }

        if (alimento.disponivel_hoje !== true) {
            indisponiveis.push({ id: alimentoId, nome: alimento.nome, motivo: 'O alimento ficou indisponível para hoje.' });
            continue;
        }

        if (!alimento.categoria_encontrada_id) {
            indisponiveis.push({ id: alimentoId, nome: alimento.nome, motivo: 'A categoria deste alimento não está mais disponível.' });
            continue;
        }

        if (alimento.categoria_deletada_em) {
            indisponiveis.push({ id: alimentoId, nome: alimento.nome, motivo: 'A categoria deste alimento foi removida.' });
            continue;
        }

        if (alimento.categoria_ativa !== true) {
            indisponiveis.push({ id: alimentoId, nome: alimento.nome, motivo: 'A categoria deste alimento está inativa.' });
        }
    }

    if (indisponiveis.length > 0) {
        return { alimentosIds, indisponiveis };
    }

    const contagemPorCategoria = {};

    for (const alimento of dadosSolicitados) {
        const limite = Number(alimento.limite_escolhas);

        if (!Number.isInteger(limite) || limite < 0) {
            lancarErro(`A categoria "${alimento.categoria_nome}" possui um limite de escolhas inválido.`, 500);
        }

        if (!contagemPorCategoria[alimento.categoria_id]) {
            contagemPorCategoria[alimento.categoria_id] = { quantidade: 0, limite, nome: alimento.categoria_nome };
        }

        contagemPorCategoria[alimento.categoria_id].quantidade += 1;
    }

    for (const categoria of Object.values(contagemPorCategoria)) {
        if (categoria.quantidade > categoria.limite) {
            lancarErro(`Limite excedido na categoria ${categoria.nome}. Máximo: ${categoria.limite}, enviado: ${categoria.quantidade}.`, 400);
        }
    }

    return { alimentosIds, indisponiveis: [] };
}

/**
 * ============================================================
 * INSERIR MARMITAS
 * ============================================================
 * O preço NUNCA vem do frontend. É sempre utilizado: tamanhos_marmitas.preco_base
 * 
 * @returns total das marmitas em centavos
 */
export async function inserirMarmitasPedido({ pedidoId, marmitas, trx }) {
    let totalCentavos = 0;
    const marmitasPreparadas = [];
    const marmitasIndisponiveis = [];

    // Primeiro valida todas as marmitas. Nenhum item é inserido enquanto existir conflito.
    for (let index = 0; index < marmitas.length; index += 1) {
        const marmita = marmitas[index];
        const tamanhoId = Number(marmita?.tamanho_id);
        const quantidade = validarQuantidade(marmita?.quantidade, 'marmitas');
        const observacao = normalizarObservacaoMarmita(marmita?.observacao);

        if (!Number.isInteger(tamanhoId) || tamanhoId <= 0) {
            lancarErro('O tamanho da marmita informado é inválido.', 400);
        }

        const tamanho = await connection('tamanhos_marmitas')
            .transacting(trx)
            .where({ id: tamanhoId, ativo: true })
            .whereNull('deletado_em')
            .forShare()
            .first();

        if (!tamanho) {
            lancarErro(`Tamanho de marmita ID ${tamanhoId} não está disponível.`, 400);
        }

        const validacaoAlimentos = await validarAlimentosDaMarmita(marmita?.alimentos, trx);

        if (validacaoAlimentos.indisponiveis.length > 0) {
            marmitasIndisponiveis.push({
                marmita_index: index,
                tamanho_id: tamanhoId,
                tamanho_nome: tamanho.nome,
                alimentos: validacaoAlimentos.indisponiveis
            });
        }

        marmitasPreparadas.push({
            tamanhoId,
            quantidade,
            observacao,
            alimentosIds: validacaoAlimentos.alimentosIds,
            precoUnitarioCentavos: paraCentavos(tamanho.preco_base)
        });
    }

    if (marmitasIndisponiveis.length > 0) {
        lancarErroAlimentosIndisponiveis(marmitasIndisponiveis);
    }

    for (const marmita of marmitasPreparadas) {
        const subtotalCentavos = marmita.precoUnitarioCentavos * marmita.quantidade;

        const [itemPedido] = await connection('itens_pedido')
            .transacting(trx)
            .insert({
                pedido_id: pedidoId,
                tamanho_marmita_id: marmita.tamanhoId,
                produto_id: null,
                marmita_especial_id: null,
                quantidade: marmita.quantidade,
                preco_unitario: deCentavos(marmita.precoUnitarioCentavos),
                subtotal: deCentavos(subtotalCentavos),
                observacao: marmita.observacao
            })
            .returning(['id']);

        const composicao = marmita.alimentosIds.map((alimentoId) => ({
            item_pedido_id: itemPedido.id,
            alimento_id: alimentoId
        }));

        await connection('composicao_item_pedido').transacting(trx).insert(composicao);
        totalCentavos += subtotalCentavos;
    }

    return totalCentavos;
}

/**
 * ============================================================
 * AGRUPAR MARMITAS ESPECIAIS
 * ============================================================
 */
function agruparMarmitasEspeciais(marmitasEspeciais, exigirPrecoReferencia = false) {
    const agrupadas = new Map();

    for (const item of marmitasEspeciais) {
        const marmitaEspecialId = Number(item?.marmita_especial_id);
        const quantidade = validarQuantidade(item?.quantidade, 'marmitas especiais');

        if (!Number.isInteger(marmitaEspecialId) || marmitaEspecialId <= 0) {
            lancarErro('O pedido possui uma marmita especial inválida.', 400);
        }

        const possuiPrecoReferencia = item?.preco_referencia !== null &&
            item?.preco_referencia !== undefined &&
            String(item.preco_referencia).trim() !== '';

        if (exigirPrecoReferencia && !possuiPrecoReferencia) {
            lancarErro('O preço de referência da marmita especial não foi informado. Atualize o carrinho e tente novamente.', 400);
        }

        let precoReferencia = null;

        if (possuiPrecoReferencia) {
            precoReferencia = Number(String(item.preco_referencia).replace(',', '.'));

            if (!Number.isFinite(precoReferencia) || precoReferencia <= 0) {
                lancarErro('O pedido possui um preço de marmita especial inválido.', 400);
            }

            precoReferencia = Number(precoReferencia.toFixed(2));
        }

        const existente = agrupadas.get(marmitaEspecialId);

        if (existente) {
            if (
                existente.preco_referencia !== null &&
                precoReferencia !== null &&
                Math.round(existente.preco_referencia * 100) !== Math.round(precoReferencia * 100)
            ) {
                lancarErro('A mesma marmita especial foi enviada com preços de referência diferentes.', 400);
            }

            existente.quantidade += quantidade;
            continue;
        }

        agrupadas.set(marmitaEspecialId, {
            marmita_especial_id: marmitaEspecialId,
            quantidade,
            preco_referencia: precoReferencia
        });
    }

    return Array.from(agrupadas.values());
}

/**
 * ============================================================
 * INSERIR MARMITAS ESPECIAIS
 * ============================================================
 *
 * O preço, nome e descrição gravados no pedido são confirmados
 * pelo Backend no momento da compra.
 */
export async function inserirMarmitasEspeciaisPedido({
    pedidoId,
    marmitasEspeciais,
    trx,
    exigirPrecoReferencia = false
}) {
    if (!Array.isArray(marmitasEspeciais)) {
        lancarErro('Marmitas especiais deve ser uma lista.', 400);
    }

    if (marmitasEspeciais.length === 0) return 0;

    const agrupadas = agruparMarmitasEspeciais(marmitasEspeciais, exigirPrecoReferencia);
    const ids = agrupadas.map((item) => item.marmita_especial_id);

    const marmitasBanco = await connection('marmitas_especiais')
        .transacting(trx)
        .select('id', 'nome', 'descricao', 'preco', 'ativo', 'deletado_em')
        .whereIn('id', ids)
        .forShare();

    const marmitasPorId = new Map(
        marmitasBanco.map((marmita) => [Number(marmita.id), marmita])
    );

    const alteracoes = [];

    for (const item of agrupadas) {
        const marmita = marmitasPorId.get(item.marmita_especial_id);

        if (!marmita) {
            alteracoes.push({
                id: item.marmita_especial_id,
                nome: null,
                tipo: 'INDISPONIVEL',
                motivo: 'A marmita especial não existe mais no cardápio.'
            });
            continue;
        }

        if (marmita.deletado_em) {
            alteracoes.push({
                id: item.marmita_especial_id,
                nome: marmita.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'A marmita especial foi removida do cardápio.'
            });
            continue;
        }

        if (marmita.ativo !== true) {
            alteracoes.push({
                id: item.marmita_especial_id,
                nome: marmita.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'A marmita especial está inativa.'
            });
            continue;
        }

        if (item.preco_referencia !== null) {
            const precoAnteriorCentavos = Math.round(item.preco_referencia * 100);
            const precoAtualCentavos = paraCentavos(marmita.preco);

            if (precoAnteriorCentavos !== precoAtualCentavos) {
                alteracoes.push({
                    id: item.marmita_especial_id,
                    nome: marmita.nome,
                    descricao_atual: marmita.descricao || null,
                    tipo: 'PRECO_ALTERADO',
                    motivo: 'O preço desta marmita especial foi alterado.',
                    preco_anterior: deCentavos(precoAnteriorCentavos),
                    preco_atual: deCentavos(precoAtualCentavos)
                });
            }
        }
    }

    if (alteracoes.length > 0) {
        lancarErroMarmitasEspeciaisAlteradas(alteracoes);
    }

    let totalCentavos = 0;

    for (const item of agrupadas) {
        const marmita = marmitasPorId.get(item.marmita_especial_id);
        const precoUnitarioCentavos = paraCentavos(marmita.preco);
        const subtotalCentavos = precoUnitarioCentavos * item.quantidade;

        await connection('itens_pedido')
            .transacting(trx)
            .insert({
                pedido_id: pedidoId,
                tamanho_marmita_id: null,
                produto_id: null,
                marmita_especial_id: marmita.id,
                quantidade: item.quantidade,
                preco_unitario: deCentavos(precoUnitarioCentavos),
                subtotal: deCentavos(subtotalCentavos),
                observacao: null,
                nome_item_snapshot: marmita.nome,
                descricao_item_snapshot: marmita.descricao || null
            });

        totalCentavos += subtotalCentavos;
    }

    return totalCentavos;
}

/**
 * ============================================================
 * AGRUPAR PRODUTOS
 * ============================================================
 */
function agruparProdutos(produtos, exigirPrecoReferencia = false) {
    const produtosAgrupados = new Map();

    for (const item of produtos) {
        const produtoId = Number(item?.produto_id);
        const quantidade = validarQuantidade(item?.quantidade, 'produtos');

        if (!Number.isInteger(produtoId) || produtoId <= 0) {
            lancarErro('O pedido possui um produto inválido.', 400);
        }

        const possuiPrecoReferencia = item?.preco_referencia !== null &&
            item?.preco_referencia !== undefined &&
            String(item.preco_referencia).trim() !== '';

        if (exigirPrecoReferencia && !possuiPrecoReferencia) {
            lancarErro('O preço de referência do produto não foi informado. Atualize o carrinho e tente novamente.', 400);
        }

        let precoReferencia = null;

        if (possuiPrecoReferencia) {
            precoReferencia = Number(String(item.preco_referencia).replace(',', '.'));

            if (!Number.isFinite(precoReferencia) || precoReferencia < 0) {
                lancarErro('O pedido possui um preço de produto inválido.', 400);
            }

            precoReferencia = Number(precoReferencia.toFixed(2));
        }

        const existente = produtosAgrupados.get(produtoId);

        if (existente) {
            if (
                existente.preco_referencia !== null &&
                precoReferencia !== null &&
                Math.round(existente.preco_referencia * 100) !== Math.round(precoReferencia * 100)
            ) {
                lancarErro('O mesmo produto foi enviado com preços de referência diferentes.', 400);
            }

            existente.quantidade += quantidade;
            continue;
        }

        produtosAgrupados.set(produtoId, {
            produto_id: produtoId,
            quantidade,
            preco_referencia: precoReferencia
        });
    }

    return Array.from(produtosAgrupados.values());
}

/**
 * ============================================================
 * INSERIR PRODUTOS
 * ============================================================
 */
export async function inserirProdutosPedido({ pedidoId, produtos, trx, exigirPrecoReferencia = false }) {
    if (!Array.isArray(produtos)) {
        lancarErro('Produtos deve ser uma lista.', 400);
    }

    if (produtos.length === 0) return 0;

    const produtosAgrupados = agruparProdutos(produtos, exigirPrecoReferencia);
    const produtosIds = produtosAgrupados.map((item) => item.produto_id);

    // Busca todos os produtos, inclusive os que ficaram indisponíveis,
    // para conseguirmos informar exatamente o que mudou.
    const produtosBanco = await connection('produtos as p')
        .transacting(trx)
        .select(
            'p.id',
            'p.nome',
            'p.preco',
            'p.ativo',
            'p.disponivel_hoje',
            'p.deletado_em',
            'p.categoria_produto_id'
        )
        .whereIn('p.id', produtosIds)
        .forShare();

    const categoriasIds = [
        ...new Set(
            produtosBanco
                .map((produto) => Number(produto.categoria_produto_id))
                .filter((id) => Number.isInteger(id) && id > 0)
        )
    ];

    const categoriasBanco = categoriasIds.length > 0
        ? await connection('categorias_produtos')
            .transacting(trx)
            .select('id', 'nome', 'ativo', 'deletado_em')
            .whereIn('id', categoriasIds)
            .forShare()
        : [];

    const produtosPorId = new Map(produtosBanco.map((produto) => [Number(produto.id), produto]));
    const categoriasPorId = new Map(categoriasBanco.map((categoria) => [Number(categoria.id), categoria]));
    const alteracoes = [];

    for (const item of produtosAgrupados) {
        const produto = produtosPorId.get(item.produto_id);

        if (!produto) {
            alteracoes.push({
                id: item.produto_id,
                nome: null,
                tipo: 'INDISPONIVEL',
                motivo: 'O produto não existe mais no cardápio.'
            });
            continue;
        }

        if (produto.deletado_em) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'O produto foi removido do cardápio.'
            });
            continue;
        }

        if (produto.ativo !== true) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'O produto está inativo.'
            });
            continue;
        }

        if (produto.disponivel_hoje !== true) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'O produto ficou indisponível para hoje.'
            });
            continue;
        }

        const categoria = categoriasPorId.get(Number(produto.categoria_produto_id));

        if (!categoria) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'A categoria deste produto não está mais disponível.'
            });
            continue;
        }

        if (categoria.deletado_em) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'A categoria deste produto foi removida.'
            });
            continue;
        }

        if (categoria.ativo !== true) {
            alteracoes.push({
                id: item.produto_id,
                nome: produto.nome,
                tipo: 'INDISPONIVEL',
                motivo: 'A categoria deste produto está inativa.'
            });
            continue;
        }

        if (item.preco_referencia !== null) {
            const precoAnteriorCentavos = Math.round(item.preco_referencia * 100);
            const precoAtualCentavos = paraCentavos(produto.preco);

            if (precoAnteriorCentavos !== precoAtualCentavos) {
                alteracoes.push({
                    id: item.produto_id,
                    nome: produto.nome,
                    tipo: 'PRECO_ALTERADO',
                    motivo: 'O preço deste produto foi alterado.',
                    preco_anterior: deCentavos(precoAnteriorCentavos),
                    preco_atual: deCentavos(precoAtualCentavos)
                });
            }
        }
    }

    if (alteracoes.length > 0) {
        lancarErroProdutosAlterados(alteracoes);
    }

    let totalCentavos = 0;

    for (const item of produtosAgrupados) {
        const produto = produtosPorId.get(item.produto_id);
        const precoUnitarioCentavos = paraCentavos(produto.preco);
        const subtotalCentavos = precoUnitarioCentavos * item.quantidade;

        await connection('itens_pedido')
            .transacting(trx)
            .insert({
                pedido_id: pedidoId,
                tamanho_marmita_id: null,
                produto_id: produto.id,
                marmita_especial_id: null,
                quantidade: item.quantidade,
                preco_unitario: deCentavos(precoUnitarioCentavos),
                subtotal: deCentavos(subtotalCentavos)
            });

        totalCentavos += subtotalCentavos;
    }

    return totalCentavos;
}

/**
 * ============================================================
 * RECALCULAR TOTAL
 * ============================================================
 */
export async function calcularTotalPedido(pedidoId, trx) {
    const itens = await connection('itens_pedido')
        .transacting(trx)
        .where('pedido_id', pedidoId)
        .select('subtotal');

    return itens.reduce((total, item) => total + paraCentavos(item.subtotal), 0);
}

/**
 * ============================================================
 * JSON DAS MARMITAS
 * ============================================================
 */
export function selecionarMarmitasJson() {
    return connection.raw(`
        COALESCE(
            (
                SELECT json_agg(item ORDER BY item.id)
                FROM (
                    SELECT
                        ip.id,
                        'PERSONALIZADA'::text AS tipo,
                        ip.tamanho_marmita_id,
                        NULL::integer AS marmita_especial_id,
                        tm.nome::text AS tamanho,
                        NULL::text AS nome,
                        NULL::text AS descricao,
                        ip.quantidade,
                        ip.preco_unitario,
                        ip.subtotal,
                        ip.observacao,
                        COALESCE(
                            (
                                SELECT json_agg(
                                    json_build_object(
                                        'id', a.id,
                                        'nome', a.nome
                                    ) ORDER BY cip.id
                                )
                                FROM composicao_item_pedido AS cip
                                JOIN alimentos AS a ON a.id = cip.alimento_id
                                WHERE cip.item_pedido_id = ip.id
                            ),
                            '[]'::json
                        ) AS alimentos
                    FROM itens_pedido AS ip
                    JOIN tamanhos_marmitas AS tm ON tm.id = ip.tamanho_marmita_id
                    WHERE ip.pedido_id = pedidos.id
                      AND ip.tamanho_marmita_id IS NOT NULL
                      AND ip.produto_id IS NULL
                      AND ip.marmita_especial_id IS NULL

                    UNION ALL

                    SELECT
                        ip.id,
                        'ESPECIAL'::text AS tipo,
                        NULL::integer AS tamanho_marmita_id,
                        ip.marmita_especial_id,
                        NULL::text AS tamanho,
                        COALESCE(ip.nome_item_snapshot, me.nome)::text AS nome,
                        COALESCE(ip.descricao_item_snapshot, me.descricao)::text AS descricao,
                        ip.quantidade,
                        ip.preco_unitario,
                        ip.subtotal,
                        ip.observacao,
                        '[]'::json AS alimentos
                    FROM itens_pedido AS ip
                    LEFT JOIN marmitas_especiais AS me ON me.id = ip.marmita_especial_id
                    WHERE ip.pedido_id = pedidos.id
                      AND ip.tamanho_marmita_id IS NULL
                      AND ip.produto_id IS NULL
                      AND ip.marmita_especial_id IS NOT NULL
                ) AS item
            ),
            '[]'::json
        ) AS marmitas
    `);
}

/**
 * ============================================================
 * JSON DOS PRODUTOS
 * ============================================================
 */
export function selecionarProdutosJson() {
    return connection.raw(`
        COALESCE(
            (
                SELECT json_agg(item ORDER BY item.id)
                FROM (
                    SELECT
                        ip.id,
                        ip.produto_id,
                        p.nome,
                        p.descricao,
                        p.categoria_produto_id AS categoria_id,
                        cp.nome AS categoria_nome,
                        ip.quantidade,
                        ip.preco_unitario,
                        ip.subtotal
                    FROM itens_pedido AS ip
                    JOIN produtos AS p ON p.id = ip.produto_id
                    JOIN categorias_produtos AS cp ON cp.id = p.categoria_produto_id
                    WHERE ip.pedido_id = pedidos.id
                      AND ip.produto_id IS NOT NULL
                      AND ip.tamanho_marmita_id IS NULL
                      AND ip.marmita_especial_id IS NULL
                ) AS item
            ),
            '[]'::json
        ) AS produtos
    `);
}

/**
 * ============================================================
 * PEDIDO COMPLETO
 * ============================================================
 */
export async function buscarPedidoCompletoPorId(pedidoId) {
    return connection('pedidos')
        .leftJoin('metodos_pagamento', 'pedidos.metodo_pagamento_id', '=', 'metodos_pagamento.id')
        .select(
            'pedidos.*',
            'metodos_pagamento.nome as metodo_pagamento_nome',
            selecionarMarmitasJson(),
            selecionarProdutosJson()
        )
        .where('pedidos.id', pedidoId)
        .first();
}

/**
 * ============================================================
 * VALIDAR STATUS DA LOJA
 * ============================================================
 */
export async function validarLojaAberta(trx) {
    const status = await connection('status_loja').transacting(trx).where({ id: 1 }).forShare().first();

    if (!status) {
        lancarErro('Configuração da loja não encontrada.', 500);
    }

    if (status.esta_aberta !== true) {
        const error = new Error('A loja fechou e não está recebendo novos pedidos. Seu carrinho foi limpo para evitar uma finalização inválida.');
        error.statusCode = 409;
        error.code = 'LOJA_FECHADA';
        error.exposeDetails = true;
        throw error;
    }

    return true;
}

/**
 * ============================================================
 * VALIDAR MÉTODO DE PAGAMENTO
 * ============================================================
 */
export async function validarMetodoPagamento(metodoPagamentoId, trx) {
    const id = Number(metodoPagamentoId);

    if (!Number.isInteger(id) || id <= 0) {
        lancarErro('Selecione um método de pagamento válido.', 400);
    }

    const metodo = await connection('metodos_pagamento')
        .transacting(trx)
        .where({ id, ativo: true })
        .first();

    if (!metodo) {
        lancarErro('O método de pagamento selecionado não está disponível.', 400);
    }

    return metodo;
}