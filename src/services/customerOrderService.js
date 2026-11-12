
import connection from '../database/connection.js';
import { buscarPedidoCompletoPorId } from '../utils/pedidosUtils.js';
import { checkoutTokenHash, paymentError, paymentStatus, trustedProviderUrl } from './infinitepayPaymentService.js';

export function customerOrdersQuery() {
    return connection('pedidos').joinRaw(`LEFT JOIN LATERAL (
        SELECT pg.status, pg.provider_verified_at, pg.receipt_url, pg.checkout_url,
            pg.valid_until, pg.capture_method
        FROM pagamentos pg
        WHERE pg.pedido_id = pedidos.id AND pg.provedor = 'INFINITEPAY'
        ORDER BY CASE WHEN pg.status IN ('PAGA', 'LIQUIDADA', 'ESTORNADA')
            AND pg.provider_verified_at IS NOT NULL THEN 0 ELSE 1 END,
            pg.tentativa_numero DESC, pg.id DESC
        LIMIT 1
    ) pagamento ON TRUE`).whereNull('pedidos.deletado_em');
}

export function customerPaymentStatus(row) {
    if (row.fluxo_pagamento !== 'INFINITEPAY') return 'TRADICIONAL';
    if (['PAGA', 'LIQUIDADA'].includes(row.pagamento_status) && !row.provider_verified_at) return 'PENDENTE';
    return paymentStatus(row.pagamento_status);
}

const summary = row => ({
    id: row.id,
    criado_em: row.criado_em,
    status: row.status,
    metodo_entrega: row.metodo_entrega,
    fluxo_pagamento: row.fluxo_pagamento,
    pagamento_status: customerPaymentStatus(row)
});

export async function listCustomerOrders(telefone) {
    const rows = await customerOrdersQuery()
        .select(
            'pedidos.id',
            'pedidos.criado_em',
            'pedidos.status',
            'pedidos.metodo_entrega',
            'pedidos.fluxo_pagamento',
            'pagamento.status as pagamento_status',
            'pagamento.provider_verified_at'
        )
        .where('pedidos.telefone_cliente', telefone)
        .orderBy('pedidos.criado_em', 'desc')
        .orderBy('pedidos.id', 'desc');

    return rows.map(summary);
}

export async function readCustomerOrder(id, token) {
    let hash;

    try {
        hash = checkoutTokenHash(token);
    } catch {
        throw paymentError('Acesso protegido. Use o navegador da compra ou entre em contato com a loja.', 404);
    }

    const row = await customerOrdersQuery()
        .where('pedidos.id', id)
        .where('pedidos.checkout_token_hash', hash)
        .select(
            'pedidos.id',
            'pedidos.status',
            'pedidos.fluxo_pagamento',
            'pagamento.status as pagamento_status',
            'pagamento.provider_verified_at',
            'pagamento.receipt_url',
            'pagamento.checkout_url',
            'pagamento.valid_until',
            'pagamento.capture_method'
        )
        .first();

    if (!row) throw paymentError('Acesso protegido. Use o navegador da compra ou entre em contato com a loja.', 404);

    const pedido = await buscarPedidoCompletoPorId(id);
    if (!pedido || pedido.deletado_em) throw paymentError('Pedido não encontrado.', 404);

    const status = customerPaymentStatus(row);

    const sums = await connection('itens_pedido')
        .where('pedido_id', id)
        .select(connection.raw(`
            COALESCE(SUM(subtotal) FILTER (WHERE produto_id IS NULL), 0) AS marmitas,
            COALESCE(SUM(subtotal) FILTER (WHERE produto_id IS NOT NULL), 0) AS produtos
        `))
        .first();

    const checkoutValid = row.fluxo_pagamento === 'INFINITEPAY'
        && status === 'PENDENTE'
        && pedido.status !== 'Cancelado'
        && new Date(row.valid_until).getTime() > Date.now();

    return {
        id: pedido.id,
        criado_em: pedido.criado_em,
        status: pedido.status,
        fluxo_pagamento: pedido.fluxo_pagamento,
        marmitas: pedido.marmitas,
        produtos: pedido.produtos,
        observacoes: pedido.observacoes,
        metodo_entrega: pedido.metodo_entrega,

        ...(pedido.metodo_entrega === 'Entrega' && pedido.endereco_cliente
            ? { endereco_cliente: pedido.endereco_cliente }
            : {}),

        metodo_pagamento_nome: row.fluxo_pagamento === 'INFINITEPAY'
            ? row.capture_method === 'pix'
                ? 'Pix'
                : row.capture_method === 'credit_card'
                    ? 'Cartão'
                    : pedido.metodo_pagamento_nome
            : pedido.metodo_pagamento_nome,

        pagamento_status: status,
        provedor: row.fluxo_pagamento === 'INFINITEPAY' ? 'InfinitePay' : null,
        receipt_url: status === 'PAGO' ? trustedProviderUrl(row.receipt_url, 'receipt') : null,
        checkout_url: checkoutValid ? trustedProviderUrl(row.checkout_url, 'checkout') : null,
        checkout_valid_until: checkoutValid ? row.valid_until : null,
        valor_total: pedido.valor_total,
        resumo: { marmitas: sums.marmitas, produtos: sums.produtos }
    };
}
