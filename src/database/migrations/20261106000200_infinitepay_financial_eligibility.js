const salesFunctions = [
    'fn_rel_faturamento_periodo',
    'fn_rel_historico_vendas',
    'fn_rel_saida_alimentos',
    'fn_rel_vendas_tamanho',
    'fn_rel_clientes_frequentes',
    'fn_rel_vendas_marmitas_especiais'
];

export async function up(knex) {
    await knex.raw(`CREATE VIEW vw_pedidos_vendas_elegiveis AS
        SELECT p.* FROM pedidos p
        WHERE p.fluxo_pagamento = 'POSTERIOR' OR EXISTS (
            SELECT 1 FROM pagamentos payment
            WHERE payment.pedido_id = p.id
                AND payment.status IN ('PAGA', 'LIQUIDADA')
                AND payment.provider_verified_at IS NOT NULL
        )`);

    for (const name of salesFunctions) {
        const result = await knex.raw('SELECT pg_get_functiondef(to_regprocedure(?)) AS definition', [name + '(json)']);
        const definition = result.rows[0]?.definition;
        if (!definition) throw new Error('Função de relatório obrigatória não encontrada: ' + name);
        // Keep each deployed function's result shape, cancellation rules and other filters.
        // Historical functions that already read the financial view need no changes.
        const updated = definition.replace(/\b(FROM|JOIN)\s+(?:public\.)?pedidos(?=\s+p\b)/gi,
            '$1 vw_pedidos_vendas_elegiveis');
        if (updated !== definition) await knex.raw(updated);
    }
}

export async function down() {
    throw new Error('Preserve a exclusão de cobranças não confirmadas. Use uma migration incremental para correções.');
}
