import connection from "../database/connection.js";
import { checkoutForOrder, checkoutTokenHash, infinitepayMethod, paymentError, prepareOnlinePayment } from "../services/infinitepayPaymentService.js";
import { getInfinitepayConfig } from "../services/infinitepayConfigService.js";
import { lancarErro } from "../utils/errorUtils.js";
import {
    buscarPedidoCompletoPorId,
    calcularTotalPedido,
    deCentavos,
    inserirMarmitasPedido,
    inserirMarmitasEspeciaisPedido,
    inserirProdutosPedido,
    normalizarTelefone,
    selecionarMarmitasJson,
    selecionarProdutosJson,
    validarLojaAberta,
    validarMetodoPagamento
} from "../utils/pedidosUtils.js";

async function responderCheckout(res, pedidoId, token, reused = false) {
    const payment = await checkoutForOrder(pedidoId);
    const statusCode = payment.checkout_url ? (reused ? 200 : 201) : 202;
    return res.status(statusCode).json({ status: 'success', data: {
        ...payment, fluxo_pagamento: 'INFINITEPAY', access_token: token, ...(reused ? { reused } : {})
    } });
}

export const criarPedido = async (req, res, next) => {
    let trx;

    try {
        const token = req.usuario ? undefined : req.body?.client_request_id;
        const tokenHash = token === undefined ? null : checkoutTokenHash(token);
        if (tokenHash) {
            trx = await connection.transaction();
            res.set('Cache-Control', 'no-store');
            await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [tokenHash]);
            const existing = await trx('pedidos').where({ checkout_token_hash: tokenHash })
                .first('id', 'fluxo_pagamento', 'valor_total');
            if (existing) {
                await trx.commit();
                if (existing.fluxo_pagamento === 'INFINITEPAY') {
                    return await responderCheckout(res, existing.id, token, true);
                }
                return res.status(200).json({ status: 'success', data: {
                    pedido_id: existing.id, total: Number(existing.valor_total), fluxo_pagamento: 'POSTERIOR', reused: true
                } });
            }
        }

        let {
            nome_cliente,
            telefone_cliente,
            endereco_cliente,
            tipo_pedido,
            metodo_entrega,
            metodo_pagamento_id,
            observacoes,
            precisa_troco = false,
            troco_para = null,
            marmitas = [],
            marmitas_especiais = [],
            produtos = []
        } = req.body || {};

        const observacoesFormatadas = observacoes === null || observacoes === undefined ? null : String(observacoes).trim() || null;

        if (observacoesFormatadas && observacoesFormatadas.length > 60) {
            lancarErro("As observações do pedido devem possuir no máximo 60 caracteres.", 400);
        }

        // const valorTrocoNumerico = precisa_troco && troco_para !== null && troco_para !== undefined && String(troco_para).trim() !== '' ? Number(troco_para) : null;

        // if (precisa_troco && (!Number.isFinite(valorTrocoNumerico) || valorTrocoNumerico <= 0)) {
        //     lancarErro("Informe um valor válido para o troco.", 400);
        // }

        const trocoOriginal = troco_para !== null && troco_para !== undefined ? String(troco_para).trim() : '';

        const valorTrocoNumerico = precisa_troco && trocoOriginal !== '' ? Number(trocoOriginal.replace(',', '.')) : null;

        if (precisa_troco) {
            const totalDigitosTroco = trocoOriginal.replace(/\D/g, '').length;

            if (totalDigitosTroco === 0 || totalDigitosTroco > 7) {
                lancarErro("O valor do troco deve possuir no máximo 7 dígitos.", 400);
            }

            if (!Number.isFinite(valorTrocoNumerico) || valorTrocoNumerico <= 0) {
                lancarErro("Informe um valor válido para o troco.", 400);
            }
        }

        if (!Array.isArray(marmitas) || !Array.isArray(marmitas_especiais) || !Array.isArray(produtos)) {
            lancarErro("Marmitas, marmitas especiais e produtos devem ser enviados como listas.", 400);
        }

        if (marmitas.length === 0 && marmitas_especiais.length === 0) {
            lancarErro("Para finalizar o pedido é obrigatório adicionar pelo menos uma marmita.", 400);
        }

        telefone_cliente = normalizarTelefone(telefone_cliente);

        if (metodo_entrega === "Entrega" && (!endereco_cliente || String(endereco_cliente).trim() === "")) {
            lancarErro("O endereço é obrigatório para pedidos com entrega.", 400);
        }

        const enderecoFinal = metodo_entrega === "Retirada"
            ? null
            : String(endereco_cliente || "").trim() || null;

        trx ??= await connection.transaction();

        // Revalida as regras críticas no momento exato da criação do pedido.
        await validarLojaAberta(trx);
        const metodo = await validarMetodoPagamento(metodo_pagamento_id, trx);
        if (metodo.codigo === 'INFINITEPAY') {
            throw paymentError('Selecione uma modalidade de pagamento disponível.', 400);
        }
        const method = req.usuario ? null : infinitepayMethod(metodo);
        const config = method ? await getInfinitepayConfig(trx, { lock: true }) : null;
        if (method && typeof config?.ativo !== 'boolean') {
            throw paymentError('Status do checkout InfinitePay indisponível.', 503);
        }
        const online = config?.ativo === true;
        if (online && !tokenHash) throw paymentError('Identificador de checkout obrigatório.', 400);

        const [pedido] = await connection("pedidos")
            .transacting(trx)
            .insert({
                nome_cliente,
                telefone_cliente,
                endereco_cliente: enderecoFinal,
                tipo_pedido,
                metodo_entrega,
                metodo_pagamento_id,
                status: "Pendente",
                fluxo_pagamento: online ? 'INFINITEPAY' : 'POSTERIOR',
                checkout_token_hash: tokenHash,
                valor_total: 0,
                observacoes: observacoesFormatadas,
                precisa_troco: Boolean(precisa_troco),
                troco_para: valorTrocoNumerico,
            })
            .returning("*");

        const checkoutItems = [];
        const totalMarmitasCentavos = await inserirMarmitasPedido({ pedidoId: pedido.id, marmitas, trx, checkoutItems });
        const totalMarmitasEspeciaisCentavos = await inserirMarmitasEspeciaisPedido({
            checkoutItems,
            pedidoId: pedido.id,
            marmitasEspeciais: marmitas_especiais,
            trx,
            exigirPrecoReferencia: !req.usuario
        });
        const totalProdutosCentavos = await inserirProdutosPedido({ pedidoId: pedido.id, produtos, trx, exigirPrecoReferencia: !req.usuario, checkoutItems });
        const valorTotalCentavos = totalMarmitasCentavos + totalMarmitasEspeciaisCentavos + totalProdutosCentavos;
        const valorTotalPedido = deCentavos(valorTotalCentavos);

        if (Boolean(precisa_troco) && valorTrocoNumerico !== null) {
            if (valorTrocoNumerico <= valorTotalPedido) {
                lancarErro(`O valor para troco (R$ ${valorTrocoNumerico.toFixed(2)}) deve ser maior que o total do pedido (R$ ${valorTotalPedido.toFixed(2)}).`, 400);
            }
        }

        await connection("pedidos")
            .transacting(trx)
            .where({ id: pedido.id })
            .update({ valor_total: valorTotalPedido });

        if (online) {
            await prepareOnlinePayment(pedido, valorTotalCentavos, trx, config, method, checkoutItems);
        }

        await connection("logs")
            .transacting(trx)
            .insert({
                tipo: "ACAO",
                usuario_id: req.usuario?.id || null,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: "PEDIDO.CRIAR",
                descricao: `Pedido #${pedido.id} para ${nome_cliente}. Total: R$ ${valorTotalPedido.toFixed(2)}`,
                payload: JSON.stringify({
                    pedido_id: pedido.id,
                    total: valorTotalPedido,
                    total_marmitas: deCentavos(totalMarmitasCentavos),
                    total_marmitas_especiais: deCentavos(totalMarmitasEspeciaisCentavos),
                    total_produtos: deCentavos(totalProdutosCentavos),
                    quantidade_marmitas: marmitas.reduce((total, marmita) => total + Number(marmita?.quantidade || 0), 0),
                    quantidade_marmitas_especiais: marmitas_especiais.reduce((total, marmita) => total + Number(marmita?.quantidade || 0), 0),
                    quantidade_produtos: produtos.reduce((total, produto) => total + Number(produto?.quantidade || 0), 0)
                })
            });

        await trx.commit();

        if (online) return await responderCheckout(res, pedido.id, token);

        // O pedido já está confirmado no banco. A falha do Socket não pode invalidar a criação nem induzir o cliente a reenviar o pedido.
        try {
            const pedidoCompleto = await buscarPedidoCompletoPorId(pedido.id);

            if (global.io && pedidoCompleto) {
                global.io.to("pedidos").emit("novo_pedido_recebido", pedidoCompleto);
            }
        } catch (socketError) {
            console.error(`Erro ao emitir o pedido #${pedido.id} pelo Socket.IO:`, socketError);
        }

        return res.status(201).json({
            status: "success",
            data: {
                pedido_id: pedido.id,
                fluxo_pagamento: 'POSTERIOR',
                total: valorTotalPedido,
                total_marmitas: deCentavos(totalMarmitasCentavos),
                total_marmitas_especiais: deCentavos(totalMarmitasEspeciaisCentavos),
                total_produtos: deCentavos(totalProdutosCentavos)
            }
        });
    } catch (error) {
        if (trx && !trx.isCompleted()) {
            await trx.rollback();
        }
        next(error);
    }
};

export const editarPedido = async (req, res, next) => {
    let trx;

    try {
        const { id } = req.params;
        const {
            nome_cliente,
            endereco_cliente,
            telefone_cliente,
            metodo_pagamento_id,
            observacoes,
            marmitas,
            marmitas_especiais,
            produtos
        } = req.body || {};

        if (marmitas !== undefined && !Array.isArray(marmitas)) {
            lancarErro("Marmitas deve ser uma lista.", 400);
        }

        if (marmitas_especiais !== undefined && !Array.isArray(marmitas_especiais)) {
            lancarErro("Marmitas especiais deve ser uma lista.", 400);
        }

        if (produtos !== undefined && !Array.isArray(produtos)) {
            lancarErro("Produtos deve ser uma lista.", 400);
        }

        const telefoneNormalizado = telefone_cliente !== undefined ? normalizarTelefone(telefone_cliente) : undefined;
        const usuarioId = req.usuario.id;

        trx = await connection.transaction();

        const pedido = await connection("pedidos")
            .transacting(trx)
            .where("id", id)
            .whereNull("deletado_em")
            .forUpdate()
            .first();

        if (!pedido) {
            lancarErro("Pedido não encontrado.", 404);
        }

        if (pedido.fluxo_pagamento === 'INFINITEPAY') {
            throw paymentError('Pedidos com cobrança online não podem ter itens, valores ou forma de pagamento alterados.');
        }
        if (metodo_pagamento_id !== undefined) {
            const metodo = await validarMetodoPagamento(metodo_pagamento_id, trx);
            if (metodo.codigo === 'INFINITEPAY') throw paymentError('Crie uma cobrança pelo checkout InfinitePay.');
        }

        if (pedido.status !== "Pendente") {
            lancarErro('Apenas pedidos com status "Pendente" podem ser editados.', 400);
        }

        if (marmitas !== undefined) {
            const itensMarmitas = await connection("itens_pedido")
                .transacting(trx)
                .where({ pedido_id: id })
                .whereNotNull("tamanho_marmita_id")
                .whereNull("produto_id")
                .whereNull("marmita_especial_id")
                .select("id");

            const idsMarmitas = itensMarmitas.map((item) => item.id);

            if (idsMarmitas.length > 0) {
                await connection("composicao_item_pedido")
                    .transacting(trx)
                    .whereIn("item_pedido_id", idsMarmitas)
                    .del();

                await connection("itens_pedido")
                    .transacting(trx)
                    .whereIn("id", idsMarmitas)
                    .del();
            }

            await inserirMarmitasPedido({ pedidoId: Number(id), marmitas, trx });
        }

        if (marmitas_especiais !== undefined) {
            await connection("itens_pedido")
                .transacting(trx)
                .where({ pedido_id: id })
                .whereNotNull("marmita_especial_id")
                .whereNull("tamanho_marmita_id")
                .whereNull("produto_id")
                .del();

            if (marmitas_especiais.length > 0) {
                await inserirMarmitasEspeciaisPedido({
                    pedidoId: Number(id),
                    marmitasEspeciais: marmitas_especiais,
                    trx,
                    exigirPrecoReferencia: false
                });
            }
        }

        if (produtos !== undefined) {
            await connection("itens_pedido")
                .transacting(trx)
                .where({ pedido_id: id })
                .whereNotNull("produto_id")
                .whereNull("tamanho_marmita_id")
                .whereNull("marmita_especial_id")
                .del();

            if (produtos.length > 0) {
                await inserirProdutosPedido({ pedidoId: Number(id), produtos, trx });
            }
        }

        const marmitaPersonalizadaComAlimento = await connection("itens_pedido as ip")
            .transacting(trx)
            .join("composicao_item_pedido as cip", "cip.item_pedido_id", "=", "ip.id")
            .where("ip.pedido_id", id)
            .whereNotNull("ip.tamanho_marmita_id")
            .whereNull("ip.produto_id")
            .whereNull("ip.marmita_especial_id")
            .first("ip.id");

        const marmitaEspecialExistente = await connection("itens_pedido as ip")
            .transacting(trx)
            .where("ip.pedido_id", id)
            .whereNotNull("ip.marmita_especial_id")
            .whereNull("ip.tamanho_marmita_id")
            .whereNull("ip.produto_id")
            .first("ip.id");

        if (!marmitaPersonalizadaComAlimento && !marmitaEspecialExistente) {
            lancarErro("O pedido deve possuir pelo menos uma marmita. Produtos não podem ser comprados separadamente.", 400);
        }

        const novoValorTotalCentavos = await calcularTotalPedido(id, trx);
        const novoValorTotal = deCentavos(novoValorTotalCentavos);

        const dadosAtualizacao = {
            nome_cliente: nome_cliente ?? pedido.nome_cliente,
            telefone_cliente: telefoneNormalizado ?? pedido.telefone_cliente,
            endereco_cliente: endereco_cliente !== undefined ? endereco_cliente : pedido.endereco_cliente,
            metodo_pagamento_id: metodo_pagamento_id ?? pedido.metodo_pagamento_id,
            observacoes: observacoes !== undefined ? observacoes : pedido.observacoes,
            valor_total: novoValorTotal,
            atualizado_em: connection.fn.now()
        };

        await connection("pedidos")
            .transacting(trx)
            .where({ id })
            .update(dadosAtualizacao);

        await connection("logs")
            .transacting(trx)
            .insert({
                tipo: "ACAO",
                usuario_id: usuarioId,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: "PEDIDO.EDITAR",
                descricao: `Pedido #${id} editado. Cliente: ${dadosAtualizacao.nome_cliente}. Total: R$ ${novoValorTotal.toFixed(2)}`,
                payload: JSON.stringify({
                    pedido_id: Number(id),
                    campos_alterados: Object.keys(req.body),
                    valor_total_anterior: Number(pedido.valor_total),
                    valor_total_novo: novoValorTotal
                })
            });

        await trx.commit();

        if (global.io) {
            global.io.to("pedidos").emit("pedido_atualizado", {
                pedido_id: Number(id),
                evento: "editado"
            });
        }

        const pedidoAtualizado = await buscarPedidoCompletoPorId(id);

        return res.status(200).json({
            status: "success",
            message: "Pedido atualizado com sucesso.",
            data: pedidoAtualizado
        });
    } catch (error) {
        if (trx && !trx.isCompleted()) {
            await trx.rollback();
        }
        next(error);
    }
};

export const alterarStatusPedido = async (req, res, next) => {
    let trx;

    try {
        const { id } = req.params;
        const { status } = req.body || {};
        const usuarioId = req.usuario.id;

        const statusValidos = [
            "Pendente",
            "Em Preparo",
            "Pronto para Retirada",
            "Saiu para Entrega",
            "Entregue",
            "Cancelado"
        ];

        if (!statusValidos.includes(status)) {
            lancarErro(`Status inválido. Use: ${statusValidos.join(", ")}`, 400);
        }

        trx = await connection.transaction();

        const pedido = await connection("pedidos")
            .transacting(trx)
            .where("id", id)
            .whereNull("deletado_em")
            .forUpdate()
            .first();

        if (!pedido) {
            lancarErro("Pedido não encontrado.", 404);
        }

        if (pedido.fluxo_pagamento === 'INFINITEPAY' && status !== 'Cancelado') {
            const confirmado = await trx('pagamentos').where({ pedido_id: pedido.id })
                .whereIn('status', ['PAGA', 'LIQUIDADA']).whereNotNull('provider_verified_at').first('id');
            if (!pedido.liberado_cozinha_em || !confirmado) {
                throw paymentError('Aguarde a confirmação do pagamento antes de iniciar a produção.');
            }
        }

        if (pedido.metodo_entrega === "Retirada" && status === "Saiu para Entrega") {
            lancarErro('Pedidos de retirada não podem receber o status "Saiu para Entrega".', 400);
        }

        if (pedido.metodo_entrega === "Entrega" && status === "Pronto para Retirada") {
            lancarErro('Pedidos de entrega não podem receber o status "Pronto para Retirada".', 400);
        }

        if (pedido.status === status) {
            await trx.rollback();
            return res.status(200).json({
                status: "success",
                message: "O pedido já possui este status."
            });
        }

        await connection("pedidos")
            .transacting(trx)
            .where({ id })
            .update({
                status,
                atualizado_em: connection.fn.now()
            });

        await connection("logs")
            .transacting(trx)
            .insert({
                tipo: "ACAO",
                usuario_id: usuarioId,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: "PEDIDO.STATUS",
                descricao: `Status do pedido #${id} alterado de "${pedido.status}" para "${status}".`,
                payload: JSON.stringify({
                    pedido_id: Number(id),
                    status_anterior: pedido.status,
                    status_novo: status,
                    metodo_entrega: pedido.metodo_entrega
                })
            });

        await trx.commit();

        if (global.io) {
            global.io.to("pedidos").emit("pedido_atualizado", {
                pedido_id: Number(id),
                evento: "status",
                status
            });
        }

        return res.status(200).json({
            status: "success",
            message: `Status atualizado para ${status}`
        });
    } catch (error) {
        if (trx && !trx.isCompleted()) {
            await trx.rollback();
        }
        next(error);
    }
};

// export const listarPedidosAdmin = async (req, res, next) => {
//     try {
//         const { page = 1, limit = 10, search = "", status = "todos" } = req.query;

//         const pagina = Math.max(Number.parseInt(page, 10) || 1, 1);
//         const porPagina = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
//         const offset = (pagina - 1) * porPagina;

//         const baseQuery = connection("pedidos").whereNull("pedidos.deletado_em");

//         if (String(search).trim()) {
//             const termo = String(search).trim();
//             baseQuery.where(function () {
//                 this.where("nome_cliente", "ILIKE", `%${termo}%`)
//                     .orWhere("telefone_cliente", "ILIKE", `%${termo}%`);

//                 if (/^\d+$/.test(termo)) {
//                     this.orWhere("pedidos.id", Number(termo));
//                 }
//             });
//         }

//         if (status !== "todos") {
//             baseQuery.where("pedidos.status", status);
//         }

//         const [{ total }] = await baseQuery.clone().count("pedidos.id as total");

//         const pedidos = await baseQuery.clone()
//             .leftJoin("metodos_pagamento", "pedidos.metodo_pagamento_id", "=", "metodos_pagamento.id")
//             .select(
//                 "pedidos.*",
//                 "metodos_pagamento.nome as metodo_pagamento_nome",
//                 selecionarMarmitasJson(),
//                 selecionarProdutosJson()
//             )
//             .orderBy("pedidos.criado_em", "desc")
//             .limit(porPagina)
//             .offset(offset);

//         const totalRegistros = Number(total || 0);

//         return res.status(200).json({
//             status: "success",
//             pagination: {
//                 total: totalRegistros,
//                 page: pagina,
//                 per_page: porPagina,
//                 totalPages: Math.max(Math.ceil(totalRegistros / porPagina), 1)
//             },
//             data: pedidos
//         });
//     } catch (error) {
//         next(error);
//     }
// };

export const listarPedidosAdmin = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, search = "", status = "todos" } = req.query;

        const pagina = Math.max(Number.parseInt(page, 10) || 1, 1);
        const porPagina = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
        const offset = (pagina - 1) * porPagina;

        const baseQuery = connection("pedidos").whereNull("pedidos.deletado_em")
            .where(function () {
                this.where('pedidos.fluxo_pagamento', 'POSTERIOR').orWhere(function () {
                    this.where('pedidos.fluxo_pagamento', 'INFINITEPAY').whereNotNull('pedidos.liberado_cozinha_em')
                        .whereExists(connection('pagamentos').select(connection.raw('1'))
                            .whereRaw('pagamentos.pedido_id = pedidos.id').whereIn('pagamentos.status', ['PAGA', 'LIQUIDADA'])
                            .whereNotNull('pagamentos.provider_verified_at'));
                });
            });

        if (String(search).trim()) {
            const termo = String(search).trim();

            baseQuery.where(function () {
                this.where("nome_cliente", "ILIKE", `%${termo}%`)
                    .orWhere("telefone_cliente", "ILIKE", `%${termo}%`);

                if (/^\d+$/.test(termo)) {
                    const pedidoId = Number(termo);

                    if (Number.isInteger(pedidoId) && pedidoId >= 1 && pedidoId <= 2147483647) {
                        this.orWhere("pedidos.id", pedidoId);
                    }
                }
            });
        }

        if (status !== "todos") {
            baseQuery.where("pedidos.status", status);
        }

        const [{ total }] = await baseQuery.clone().count("pedidos.id as total");

        const pedidos = await baseQuery.clone()
            .leftJoin("metodos_pagamento", "pedidos.metodo_pagamento_id", "=", "metodos_pagamento.id")
            .select(
                "pedidos.*",
                "metodos_pagamento.nome as metodo_pagamento_nome",
                selecionarMarmitasJson(),
                selecionarProdutosJson()
            )
            .orderBy("pedidos.criado_em", "desc")
            .limit(porPagina)
            .offset(offset);

        const totalRegistros = Number(total || 0);

        return res.status(200).json({
            status: "success",
            pagination: {
                total: totalRegistros,
                page: pagina,
                per_page: porPagina,
                totalPages: Math.max(Math.ceil(totalRegistros / porPagina), 1)
            },
            data: pedidos.map(({ checkout_token_hash, ...pedido }) => pedido)
        });
    } catch (error) {
        next(error);
    }
};

export const listarPedidosPorTelefoneUsuario = async (req, res, next) => {
    try {
        const telefone = normalizarTelefone(req.params.telefone);

        const pedidos = await connection("pedidos")
            .select(
                "pedidos.id",
                "pedidos.nome_cliente",
                "pedidos.status",
                "pedidos.valor_total",
                "pedidos.metodo_pagamento_id",
                "pedidos.metodo_entrega",
                "pedidos.endereco_cliente",
                "pedidos.observacoes",
                "pedidos.precisa_troco",
                "pedidos.troco_para",
                "pedidos.criado_em",
                selecionarMarmitasJson(),
                selecionarProdutosJson()
            )
            .where("pedidos.telefone_cliente", telefone)
            .where('pedidos.fluxo_pagamento', 'POSTERIOR')
            .whereNull("pedidos.deletado_em")
            .orderBy("pedidos.criado_em", "desc");

        if (pedidos.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "Nenhum pedido encontrado para este número de telefone."
            });
        }

        return res.status(200).json({
            status: "success",
            results: pedidos.length,
            data: pedidos
        });
    } catch (error) {
        next(error);
    }
};

export const deletarPedido = async (req, res, next) => {
    let trx;

    try {
        const { id } = req.params;
        const usuarioId = req.usuario.id;

        trx = await connection.transaction();

        const pedido = await connection("pedidos")
            .transacting(trx)
            .where("id", id)
            .whereNull("deletado_em")
            .forUpdate()
            .first();

        if (!pedido) {
            lancarErro("Pedido não encontrado ou já foi excluído.", 404);
        }

        await connection("pedidos")
            .transacting(trx)
            .where({ id })
            .update({
                status: "Cancelado",
                deletado_em: connection.fn.now(),
                atualizado_em: connection.fn.now()
            });

        await connection("logs")
            .transacting(trx)
            .insert({
                tipo: "ACAO",
                usuario_id: usuarioId,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: "PEDIDO.DELETAR",
                descricao: `Admin realizou soft delete no pedido #${id} do cliente ${pedido.nome_cliente}.`,
                payload: JSON.stringify({
                    pedido_id: Number(id),
                    valor_total: Number(pedido.valor_total),
                    status_anterior: pedido.status
                })
            });

        await trx.commit();

        if (global.io) {
            global.io.to("pedidos").emit("pedido_atualizado", {
                pedido_id: Number(id),
                evento: "removido"
            });
        }

        return res.status(200).json({
            status: "success",
            message: "Pedido excluído com sucesso."
        });
    } catch (error) {
        if (trx && !trx.isCompleted()) {
            await trx.rollback();
        }
        next(error);
    }
};

export const restaurarPedido = async (req, res, next) => {
    let trx;

    try {
        const { id } = req.params;
        const usuarioId = req.usuario.id;

        trx = await connection.transaction();

        const pedido = await connection("pedidos")
            .transacting(trx)
            .where("id", id)
            .forUpdate()
            .first();

        if (!pedido) {
            lancarErro("Pedido não encontrado.", 404);
        }

        if (pedido.deletado_em === null) {
            await trx.rollback();
            return res.status(400).json({
                status: "error",
                message: "Este pedido já está ativo (não excluído)."
            });
        }

        let liberadoCozinhaEm = pedido.liberado_cozinha_em;
        if (pedido.fluxo_pagamento === 'INFINITEPAY') {
            const confirmado = await trx('pagamentos').where({ pedido_id: pedido.id })
                .whereIn('status', ['PAGA', 'LIQUIDADA']).whereNotNull('provider_verified_at')
                .forUpdate().first();
            liberadoCozinhaEm = confirmado && Number(confirmado.valor_centavos) === Math.round(Number(pedido.valor_total) * 100)
                ? pedido.liberado_cozinha_em || connection.fn.now() : null;
        }

        await connection("pedidos")
            .transacting(trx)
            .where({ id })
            .update({
                deletado_em: null,
                status: "Pendente",
                liberado_cozinha_em: liberadoCozinhaEm,
                atualizado_em: connection.fn.now()
            });

        await connection("logs")
            .transacting(trx)
            .insert({
                tipo: "ACAO",
                usuario_id: usuarioId,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: "PEDIDO.RESTAURAR",
                descricao: `Admin restaurou o pedido #${id} do cliente ${pedido.nome_cliente}.`,
                payload: JSON.stringify({
                    pedido_id: Number(id),
                    status_anterior: pedido.status,
                    status_novo: "Pendente"
                })
            });

        await trx.commit();

        if (global.io && (pedido.fluxo_pagamento !== 'INFINITEPAY' || liberadoCozinhaEm)) {
            global.io.to("pedidos").emit("pedido_atualizado", {
                pedido_id: Number(id),
                evento: "restaurado",
                status: "Pendente"
            });
        }

        return res.status(200).json({
            status: "success",
            message: "Pedido restaurado e enviado de volta para a lista de Pendentes."
        });
    } catch (error) {
        if (trx && !trx.isCompleted()) {
            await trx.rollback();
        }
        next(error);
    }
};
