import { lancarErro } from './errorUtils.js';

const camposFinanceiros = new Set([
    'fluxo_pagamento', 'liberado_cozinha_em', 'provider_verified_at', 'pago_em',
    'status_pagamento', 'payment_status', 'bloqueia_nova_cobranca', 'pagamentos'
]);

// Mesmo whitespace de String.trim(), sem depender do locale do PostgreSQL.
const whitespaceIdentificador = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export function rejeitarControleFinanceiro(input) {
    if (input && Object.keys(input).some(campo => camposFinanceiros.has(campo))) {
        lancarErro('O controle financeiro do pedido é exclusivo do servidor.', 400);
    }
}

export function definirFluxoCriacao({ origem, metodo, habilitado, configAtiva }) {
    if (!['PUBLICO', 'ADMIN'].includes(origem)) lancarErro('Origem de pedido inválida.', 400);
    const metodoOnline = ['PIX', 'CREDITO'].includes(metodo.codigo) && metodo.tipo_financeiro === metodo.codigo;
    if (origem === 'PUBLICO' && habilitado === true && configAtiva === true && metodoOnline) {
        // A seleção futura já é confiável, mas esta etapa não cria checkout nem pedido online incompleto.
        lancarErro('Checkout online indisponível nesta etapa.', 503);
    }
    return 'POSTERIOR';
}

export function aplicarElegibilidadeOperacional(query) {
    return query.where(function () {
        this.where('pedidos.fluxo_pagamento', 'POSTERIOR').orWhere(function () {
            this.where('pedidos.fluxo_pagamento', 'INFINITEPAY')
                .whereNotNull('pedidos.liberado_cozinha_em')
                .whereExists(function () {
                    this.select(1).from('pagamentos as financeiro')
                        .whereColumn('financeiro.pedido_id', 'pedidos.id')
                        .whereIn('financeiro.status', ['PAGA', 'LIQUIDADA', 'ESTORNADA'])
                        .whereNotNull('financeiro.provider_verified_at')
                        .whereNotNull('financeiro.pago_em')
                        .whereRaw('LENGTH(BTRIM(??, ?)) > 0', ['financeiro.transaction_nsu', whitespaceIdentificador])
                        .whereRaw('LENGTH(BTRIM(??, ?)) > 0', ['financeiro.invoice_slug', whitespaceIdentificador])
                        .whereIn('financeiro.capture_method', ['pix', 'credit_card'])
                        .whereColumn('financeiro.valor_base_provider_centavos', 'financeiro.valor_centavos')
                        .whereRaw('?? = ROUND(?? * 100)', ['financeiro.valor_centavos', 'pedidos.valor_total']);
                });
        });
    });
}

export async function exigirElegibilidadeOperacional(pedido, trx) {
    const elegivel = await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id', pedido.id).first('pedidos.id');
    if (!elegivel) lancarErro('Pedido ainda não liberado financeiramente para operação.', 409);
}

export async function exigirMutacaoSemCobranca(pedido, trx) {
    // Cancelar, restaurar ou recalcular uma cobrança exige o fluxo financeiro de uma etapa posterior.
    if (pedido.fluxo_pagamento === 'INFINITEPAY' ||
        await trx('pagamentos').where({ pedido_id: pedido.id }).first('id')) {
        lancarErro('Pedido com vínculo financeiro não pode ser alterado por esta operação.', 409);
    }
}
