import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrateBaseline, migrateInfinitepayFoundation, historicalOrder } from '../helpers/testDatabase.js';

test('additive schema preserves synthetic historical IDs, totals, items and legacy kitchen eligibility', async () => {
    const f = await createTestDatabase();
    try {
        await migrateBaseline(f.db);
        const order = await historicalOrder(f.db, { id: 701, methodId: 91 });
        const before = await f.db('pedidos').where({ id: order.id }).first();
        await migrateInfinitepayFoundation(f.db);
        const after = await f.db('pedidos').where({ id: order.id }).first();
        for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
        assert.equal(after.fluxo_pagamento, 'POSTERIOR');
        assert.equal(after.liberado_cozinha_em, null);
        const method = await f.db('metodos_pagamento').where({ id: 91 }).first();
        assert.equal(method.codigo, null);
        assert.equal(method.tipo_financeiro, 'OUTRO');
        assert.equal(await f.db('itens_pedido').where({ pedido_id: 701 }).count('* as n').first().then(r => Number(r.n)), 1);
        const migrationHistory = await f.db('knex_migrations').select('*').orderBy('id');
        await assert.rejects(f.db.migrate.rollback(), /Rollback bloqueado.*forward-only/i);
        assert.equal(await f.db.schema.hasTable('pagamentos'), true);
        assert.deepEqual(await f.db('knex_migrations').select('*').orderBy('id'), migrationHistory);
        assert.equal((await f.db('pedidos').where({ id: 701 }).first()).valor_total, '20.00');
        await migrateInfinitepayFoundation(f.db);
        assert.equal((await f.db('config_infinitepay').first()).ativo, false);
    } finally { await f.close(); }
});

test('constraints prevent concurrent chargeable attempts and protect external facts, events and access scopes', async () => {
    const f = await createTestDatabase();
    try {
        await f.db.migrate.latest();
        const order = await historicalOrder(f.db);
        const attempt = n => ({ pedido_id: order.id, tentativa_numero: n, order_nsu: 'SYNTH-'+n,
            status: 'INCERTA', valor_centavos: 2000, valid_until: '2030-01-01T23:59:59Z' });
        const results = await Promise.allSettled([f.db('pagamentos').insert(attempt(1)), f.db('pagamentos').insert(attempt(2))]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(results.find(r => r.status === 'rejected').reason.code, '23505');
        const payment = await f.db('pagamentos').first();
        await f.db('pagamentos').where({ id: payment.id }).update({ status: 'DIVERGENTE' });
        await assert.rejects(f.db('pagamentos').insert(attempt(3)), { code: '23505' });
        await f.db('pagamentos').where({ id: payment.id }).update({ status: 'FALHOU' });
        await assert.rejects(f.db('pagamentos').insert(attempt(4)), { code: '23505' });
        await assert.rejects(f.db('pagamentos').insert({ ...attempt(5), pedido_id: 99999 }), { code: '23503' });
        await assert.rejects(f.db('pagamentos').where({ id: payment.id }).update({ valor_centavos: -1 }), { code: '23514' });
        await f.db('pagamentos').where({ id: payment.id }).update({ status: 'PAGA', bloqueia_nova_cobranca: false });
        // Store a second real external payment for investigation without a second kitchen release.
        await f.db('pagamentos').insert({ ...attempt(6), status: 'PAGA', bloqueia_nova_cobranca: false });
        await f.db('outbox_eventos').insert({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO', chave_unica: 'pedido_liberado:'+order.id });
        await assert.rejects(f.db('outbox_eventos').insert({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO', chave_unica: 'pedido_liberado:'+order.id }), { code: '23505' });
        await assert.rejects(f.db('outbox_eventos').insert({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO', chave_unica: 'different-release-key' }), { code: '23505' });
        await f.db('pagamentos_eventos').insert({ event_key: 'synthetic:1', tipo_evento: 'SINTETICO' });
        await assert.rejects(f.db('pagamentos_eventos').insert({ event_key: 'synthetic:1', tipo_evento: 'SINTETICO' }), { code: '23505' });
        await assert.rejects(f.db('pedido_acessos').insert({ pedido_id: order.id, token_hash: 'a'.repeat(64), escopo: 'ADMIN', expira_em: '2030-01-01' }), { code: '23514' });
        await assert.rejects(f.db.migrate.rollback(), /Rollback bloqueado.*forward-only/i);
        assert.equal(await f.db('pagamentos').count('* as n').first().then(r => Number(r.n)), 2);
    } finally { await f.close(); }
});

test('request identity requires its payload hash and is unique across orders', async () => {
    const f = await createTestDatabase();
    try {
        await f.db.migrate.latest();
        const first = await historicalOrder(f.db);
        const uuid = '11111111-1111-4111-8111-111111111111';
        await assert.rejects(f.db('pedidos').where({id:first.id}).update({client_request_id:uuid}), {code:'23514'});
        await f.db('pedidos').where({id:first.id}).update({client_request_id:uuid,client_payload_hash:'a'.repeat(64)});
        const second = await historicalOrder(f.db,{id:2,methodId:18});
        await assert.rejects(f.db('pedidos').where({id:second.id}).update({client_request_id:uuid,client_payload_hash:'b'.repeat(64)}), {code:'23505'});
    } finally {await f.close();}
});
