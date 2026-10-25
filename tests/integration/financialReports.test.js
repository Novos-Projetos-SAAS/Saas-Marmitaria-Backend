import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../helpers/testDatabase.js';

let fixture, db, size, food, originalRows, legacyReports, historyId, originalFunctions;
const migrationQueries = [];
const legacyNames = ['fn_rel_faturamento_periodo','fn_rel_vendas_tamanho','fn_rel_saida_alimentos','fn_rel_clientes_frequentes','fn_rel_historico_vendas'];
const period = { data_inicio: '2026-10-25', data_fim: '2026-10-25' };
const report = async (name, filters = period) => (await db.raw('SELECT * FROM ??(?)', [name, JSON.stringify(filters)])).rows;
async function order(id, { flow = 'POSTERIOR', status = 'Pendente', method = 91, created = '2026-10-25T15:00:00Z', special } = {}) {
    await db('pedidos').insert({ id, nome_cliente: 'Sintético ' + id, telefone_cliente: '11999999999', tipo_pedido: 'Presencial',
        metodo_entrega: 'Retirada', metodo_pagamento_id: method, valor_total: 20, fluxo_pagamento: flow, status, criado_em: created });
    const [item] = await db('itens_pedido').insert({ pedido_id: id, tamanho_marmita_id: special ? null : size.id,
        marmita_especial_id: special || null, nome_item_snapshot: special ? 'Especial histórico ' + special : null,
        quantidade: 1, preco_unitario: 20, subtotal: 20 }).returning('*');
    if (!special) await db('composicao_item_pedido').insert({ item_pedido_id: item.id, alimento_id: food.id });
}
async function attempt(id, status, { verified = false, number = 1, ...extra } = {}) {
    const [row] = await db('pagamentos').insert({ pedido_id: id, tentativa_numero: number, order_nsu: 'SYNTHETIC-' + id + '-' + number,
        status, valor_centavos: 2000, valid_until: '2026-11-01T00:00:00Z', bloqueia_nova_cobranca: number === 1,
        ...(verified ? { provider_verified_at: '2026-10-26T01:30:00Z', pago_em: '2026-10-26T01:30:00Z',
            transaction_nsu: 'synthetic-txn-' + id, invoice_slug: 'synthetic-slug-' + id, capture_method: 'credit_card',
            valor_base_provider_centavos: 2000, valor_pago_provider_centavos: 2100, installments: 1 } : {}), ...extra }).returning('*');
    return row;
}
before(async () => {
    fixture = await createTestDatabase(); db = fixture.db;
    const previous = '20261024000100_checkout_sessoes.js';
    const { readdir } = await import('node:fs/promises');
    const { migrations } = await import('../helpers/testDatabase.js');
    for (const name of (await readdir(migrations)).filter(n => n.endsWith('.js') && n <= previous).sort()) await db.migrate.up({ name });
    await db('metodos_pagamento').insert([
        { id: 91, nome: 'Dinheiro editável', codigo: 'DINHEIRO', tipo_financeiro: 'DINHEIRO' },
        { id: 17, nome: 'Débito editável', codigo: 'CARTAO_DEBITO', tipo_financeiro: 'DEBITO' },
        { id: 308, nome: 'Método personalizado' },
        { id: 54, nome: 'Pix editável', codigo: 'PIX', tipo_financeiro: 'PIX' }
    ]);
    [size] = await db('tamanhos_marmitas').insert({ nome: 'Tamanho histórico', preco_base: 20 }).returning('*');
    const [category] = await db('categorias_alimentos').insert({ nome: 'Categoria sintética' }).returning('*');
    [food] = await db('alimentos').insert({ nome: 'Alimento histórico', categoria_id: category.id }).returning('*');
    await order(1); await order(2, { method: 17 }); await order(3, { method: 308 });
    await order(4, { flow: 'INFINITEPAY', method: 54 }); await attempt(4, 'INCERTA');
    await order(5, { flow: 'INFINITEPAY', method: 54 });
    const payment = await attempt(5, 'PAGA', { verified: true });
    await attempt(5, 'FALHOU', { number: 2 });
    await db('pagamentos_eventos').insert([1, 2, 3].map(n => ({ pagamento_id: payment.id, event_key: 'synthetic-duplicate-' + n, tipo_evento: 'WEBHOOK' })));
    await order(6, { flow: 'INFINITEPAY', method: 54 });
    await attempt(6, 'ESTORNADA', { verified: true, estornado_em: '2026-10-27T01:00:00Z' });
    await order(7, { flow: 'INFINITEPAY', method: 54, status: 'Cancelado' }); await attempt(7, 'INCERTA');
    await order(8, { flow: 'INFINITEPAY', method: 54, status: 'Cancelado' }); await attempt(8, 'PAGA', { verified: true });
    await order(9, { status: 'Cancelado' });
    await order(10, { flow: 'INFINITEPAY', method: 54 }); await attempt(10, 'PAGA');
    await order(11, { flow: 'INFINITEPAY', method: 54 }); await attempt(11, 'LIQUIDADA', { verified: true, liquidado_em: '2026-10-25T23:00:00Z' });
    await order(12, { created: '2026-10-25T01:59:00Z' }); // Previous SP day, independent of server TZ.
    await order(13, { flow: 'INFINITEPAY', method: 54 }); await attempt(13, 'PAGA', { verified: true, transaction_nsu: '\u00a0\u2003\ufeff' });
    await order(14, { flow: 'INFINITEPAY', method: 54 }); await attempt(14, 'PAGA', { verified: true, valor_base_provider_centavos: 1999 });
    for (let n = 1; n <= 5; n++) {
        const [special] = await db('marmitas_especiais').insert({ nome: 'Especial atual ' + n, preco: 20 }).returning('*');
        await order(20 + n, { special: special.id });
    }
    for (const [id, method, status] of [[100,91,'Pendente'],[101,17,'Entregue'],[102,308,'Em Preparo'],[103,91,'Cancelado']]) {
        await order(id, { method, status, created: '2025-01-15T15:00:00Z' });
    }
    legacyReports = Object.fromEntries(await Promise.all(legacyNames.map(async name => [name,
        await report(name, { data_inicio: '2025-01-15', data_fim: '2025-01-15' })])));
    originalFunctions = (await db.raw("SELECT oid, proname FROM pg_proc WHERE pronamespace = ?::regnamespace AND proname LIKE 'fn_rel_%' ORDER BY oid", [fixture.schema])).rows;
    [historyId] = await db('catalogo_relatorios').insert({ nome: 'Histórico preservado', funcao_db: 'fn_rel_historico_vendas', ativo: true,
        filtros_config: JSON.stringify([{ nome: 'tipo_pedido', tipo: 'select', opcoes: ['todos','Presencial','Remoto'] }]),
        colunas_config: JSON.stringify([{ chave: 'pedido_id', label: 'Pedido' }, { chave: 'valor_total', label: 'Valor', totalizar: true }]) }).returning('id');
    originalRows = { orders: await db('pedidos').orderBy('id'), items: await db('itens_pedido').orderBy('id'), payments: await db('pagamentos').orderBy('id'),
        methods: await db('metodos_pagamento').orderBy('id'), events: await db('pagamentos_eventos').orderBy('id') };
    const listener = query => migrationQueries.push(query.sql);
    db.on('query', listener);
    try { await db.migrate.up({ name: '20261025000100_relatorios_financeiros.js' }); } finally { db.removeListener('query', listener); }
});
after(async () => { await fixture?.close(); });

test('financial view has exactly one row per order and does not count attempts or webhook duplicates', async () => {
    const rows = await db('vw_rel_pedidos_financeiros').orderBy('id');
    assert.equal(rows.length, originalRows.orders.length);
    assert.equal(rows.filter(r => r.id === 5).length, 1);
    assert.equal(Number(rows.find(r => r.id === 5).valor_venda), 20);
    assert.equal(rows.find(r => r.id === 5).situacao_financeira, 'PAGA');
});
test('legacy cash, debit, PDV and custom historical methods retain sale semantics with checkout off', async () => {
    const rows = await db('vw_rel_pedidos_financeiros').whereIn('id', [1, 2, 3, 9]);
    for (const row of rows) { assert.equal(row.pagamento_confirmado, false); assert.equal(Number(row.valor_venda), row.id === 9 ? 0 : 20); }
    assert.equal((await db('config_infinitepay').first()).ativo, false);
});
test('unverified, uncertain, blank-identifier and mismatched-value payments never become sales', async () => {
    const rows = await db('vw_rel_pedidos_financeiros').whereIn('id', [4, 7, 10, 13, 14]);
    for (const row of rows) { assert.equal(row.venda_considerada, false); assert.equal(row.pagamento_confirmado, false); assert.equal(Number(row.valor_venda), 0); }
});
test('refund is separate and operational cancellation does not erase a proven payment', async () => {
    const rows = await db('vw_rel_pedidos_financeiros').whereIn('id', [6, 8, 11]);
    assert.equal(rows.find(r => r.id === 6).estorno_comprovado, true);
    assert.equal(Number(rows.find(r => r.id === 6).valor_venda), 0);
    assert.equal(Number(rows.find(r => r.id === 8).valor_venda), 20);
    assert.equal(Number(rows.find(r => r.id === 11).valor_venda), 20);
});
test('revenue and ticket include only eligible sales, using SP order creation date', async () => {
    const rows = await report('fn_rel_faturamento_periodo');
    assert.equal(rows.length, 1); assert.equal(Number(rows[0].total_faturado), 220);
    assert.equal(Number(rows[0].qtd_pedidos), 18); // Includes operational orders, not just eligible sales.
    assert.equal(Number(rows[0].ticket_medio), 20);
    assert.equal((await report('fn_rel_faturamento_periodo', { ...period, data_inicio: '2026-10-24', data_fim: '2026-10-24' }))[0].total_faturado, '20.00');
});
test('size, food, special meals and frequent customers exclude unpaid and refunded sales', async () => {
    assert.equal(Number((await report('fn_rel_vendas_tamanho'))[0].qtd_vendida), 5); // Canceled paid is money, not production.
    assert.equal(Number((await report('fn_rel_saida_alimentos'))[0].qtd_escolhida), 5);
    const specials = await report('fn_rel_vendas_marmitas_especiais');
    assert.equal(specials.length, 5); assert.ok(specials.every(r => Number(r.total_faturado) === 20 && r.marmita_nome.startsWith('Especial histórico')));
    const customers = await report('fn_rel_clientes_frequentes');
    assert.equal(customers.reduce((s, r) => s + Number(r.valor_gasto), 0), 220);
});
test('financial report exposes bases separately with explicit confirmation/refund dates and no invented net/fees', async () => {
    const rows = await report('fn_rel_pagamentos_infinitepay', { ...period, criterio_temporal: 'confirmacao' });
    assert.deepEqual(rows.map(r => r.pedido_id).sort((a, b) => a - b), [5, 6, 8, 11]);
    assert.ok(rows.every(r => Number(r.valor_original) === 20 && Number(r.valor_pago_comprador) === 21 && r.taxas === null && r.valor_liquido === null && r.valor_estornado === null));
    assert.ok(rows.every(r => r.meio_confirmado === 'credit_card'));
    const refunds = await report('fn_rel_pagamentos_infinitepay', { ...period, data_inicio: '2026-10-26', data_fim: '2026-10-26', criterio_temporal: 'estorno' });
    assert.deepEqual(refunds.map(r => r.pedido_id), [6]);
    assert.ok(!JSON.stringify(rows).includes('synthetic-txn-')); assert.ok(!JSON.stringify(rows).includes('synthetic-slug-'));
    await assert.rejects(report('fn_rel_pagamentos_infinitepay', { ...period, criterio_temporal: 'inventado' }));
});
test('extended history preserves order values and labels unpaid value separately', async () => {
    const rows = await report('fn_rel_historico_vendas_financeiro');
    const uncertain = rows.find(r => r.pedido_id === 4);
    assert.equal(Number(uncertain.valor_total), 20); assert.equal(Number(uncertain.valor_considerado), 0);
    assert.equal(uncertain.situacao_financeira, 'INCERTA');
    assert.equal(rows.some(r => r.pedido_id === 9), false); // Existing history excludes canceled orders.
});
test('incremental migration preserves every order, item and payment and refuses rollback', async () => {
    assert.deepEqual(await db('pedidos').orderBy('id'), originalRows.orders);
    assert.deepEqual(await db('itens_pedido').orderBy('id'), originalRows.items);
    assert.deepEqual(await db('pagamentos').orderBy('id'), originalRows.payments);
    assert.deepEqual(await db('metodos_pagamento').orderBy('id'), originalRows.methods);
    assert.deepEqual(await db('pagamentos_eventos').orderBy('id'), originalRows.events);
    assert.deepEqual(migrationQueries.filter(sql => /^\s*(DROP|DELETE|TRUNCATE)\b/i.test(sql) || /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql)), []);
    await assert.rejects(db.migrate.down({ name: '20261025000100_relatorios_financeiros.js' }), /forward-only/);
});

test('legacy-only period retains previous report values and all historical SQL function identities', async () => {
    for (const name of legacyNames) assert.deepEqual(await report(name, { data_inicio: '2025-01-15', data_fim: '2025-01-15' }), legacyReports[name], name);
    const functions = (await db.raw("SELECT oid, proname FROM pg_proc WHERE pronamespace = ?::regnamespace ORDER BY oid", [fixture.schema])).rows;
    for (const old of originalFunctions) assert.ok(functions.some(f => f.oid === old.oid && f.proname === old.proname));
    const history = await db('catalogo_relatorios').where({ id: historyId.id }).first();
    assert.equal(history.funcao_db, 'fn_rel_historico_vendas_financeiro');
    assert.equal(history.colunas_config.find(c => c.chave === 'valor_total').totalizar, false);
    assert.equal(history.colunas_config.find(c => c.chave === 'valor_considerado').totalizar, true);
    assert.equal(history.colunas_config.find(c => c.chave === 'situacao_financeira')?.label, 'Situação financeira');
    assert.ok(history.colunas_config.every(c => typeof c.chave === 'string'));
    const financial = await db('catalogo_relatorios').where({ funcao_db: 'fn_rel_pagamentos_infinitepay' }).first();
    assert.ok(financial.filtros_config.every(filter => typeof filter.nome === 'string'));
    assert.deepEqual(history.filtros_config[0].opcoes, ['todos','Presencial','Remoto']);
});

for (const status of ['CRIANDO','AGUARDANDO','FALHOU','EXPIRADA','CANCELADA','DIVERGENTE']) {
    test(status + ' is not a confirmed payment even when metadata is present', async () => {
        const id = 200 + ['CRIANDO','AGUARDANDO','FALHOU','EXPIRADA','CANCELADA','DIVERGENTE'].indexOf(status);
        await order(id, { flow: 'INFINITEPAY', created: '2051-01-01T15:00:00Z' });
        await attempt(id, status, { verified: true });
        const row = await db('vw_rel_pedidos_financeiros').where({ id }).first();
        assert.equal(row.pagamento_confirmado, false); assert.equal(Number(row.valor_venda), 0);
    });
}
test('two apparently confirmed attempts and repeated events still produce one financial row', async () => {
    await order(300, { flow: 'INFINITEPAY', created: '2051-01-01T15:00:00Z' });
    await attempt(300, 'PAGA', { verified: true }); await attempt(300, 'PAGA', { verified: true, number: 2 });
    const rows = await report('fn_rel_pagamentos_infinitepay', { data_inicio: '2051-01-01', data_fim: '2051-01-01' });
    assert.equal(rows.filter(r => r.pedido_id === 300).length, 1);
    assert.equal(rows.filter(r => r.pedido_id === 300).reduce((sum,r) => sum + Number(r.valor_confirmado), 0), 20);
});
test('SP date boundaries do not change with the database session timezone', async () => {
    for (const timezone of ['UTC','America/Sao_Paulo','Asia/Tokyo']) await db.transaction(async trx => {
        await trx.raw('SELECT set_config(?, ?, true)', ['TimeZone', timezone]);
        const rows = (await trx.raw('SELECT * FROM fn_rel_faturamento_periodo(?)', [JSON.stringify(period)])).rows;
        assert.equal(Number(rows[0].total_faturado), 220);
    });
});

test('catalog seed after migrations and repeated seeding never recreates the unsafe legacy history', async () => {
    const { seed } = await import('../../src/database/seeds/06_insercao_de_tipos_de_relatorios_no banco.js');
    await seed(db); await seed(db);
    assert.equal(Number((await db('catalogo_relatorios').where({ funcao_db: 'fn_rel_historico_vendas' }).count('* as n').first()).n), 0);
    const histories = await db('catalogo_relatorios').where({ funcao_db: 'fn_rel_historico_vendas_financeiro' });
    assert.equal(histories.length, 1); assert.equal(histories[0].id, historyId.id);
    assert.equal(histories[0].colunas_config.find(c => c.chave === 'valor_total').totalizar, false);
    assert.ok(histories[0].colunas_config.find(c => c.chave === 'situacao_financeira'));
    const rows = await report(histories[0].funcao_db);
    assert.equal(Number(rows.find(r => r.pedido_id === 4).valor_considerado), 0);
    const empty = await createTestDatabase();
    try {
        await empty.db.migrate.latest(); await seed(empty.db); await seed(empty.db);
        const catalog = await empty.db('catalogo_relatorios').where('funcao_db', 'like', 'fn_rel_historico_vendas%');
        assert.equal(catalog.length, 1); assert.equal(catalog[0].funcao_db, 'fn_rel_historico_vendas_financeiro');
        assert.ok(catalog[0].colunas_config.find(c => c.chave === 'valor_considerado' && c.totalizar));
    } finally { await empty.close(); }
});
