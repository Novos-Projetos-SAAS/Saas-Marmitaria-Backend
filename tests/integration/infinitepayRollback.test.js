import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrateBaseline, historicalOrder } from '../helpers/testDatabase.js';
import { down } from '../../src/database/migrations/20261022000100_infinitepay_metodos_pedidos.js';

const name = '20261022000100_infinitepay_metodos_pedidos.js';
async function fixture() {
    const f = await createTestDatabase();
    try {
        await migrateBaseline(f.db);
        const order = await historicalOrder(f.db);
        await f.db.migrate.up({ name });
        return { ...f, order };
    } catch (error) { await f.close(); throw error; }
}
async function snapshot(db) {
    return {
        orders: await db('pedidos').select('*').orderBy('id'),
        methods: await db('metodos_pagamento').select('*').orderBy('id'),
        items: await db('itens_pedido').select('*').orderBy('id')
    };
}

const cases = [
    { name: 'InfinitePay flow', table: 'pedidos', values: { fluxo_pagamento: 'INFINITEPAY' } },
    { name: 'kitchen release timestamp without financial flow', table: 'pedidos', values: { liberado_cozinha_em: '2026-10-22T15:00:00Z' } },
    { name: 'request UUID and hash', table: 'pedidos', values: {
        client_request_id: '11111111-1111-4111-8111-111111111111', client_payload_hash: 'a'.repeat(64)
    } },
    { name: 'stable code with default financial type', table: 'metodos_pagamento', values: { codigo: 'VERIFIED_CUSTOM' } },
    ...['PIX', 'CREDITO', 'DEBITO', 'DINHEIRO'].map(type => ({
        name: 'financial classification ' + type + ' without a code', table: 'metodos_pagamento', values: { tipo_financeiro: type }
    }))
];
for (const scenario of cases) {
    test('migration 001 rollback preserves ' + scenario.name, async () => {
        const f = await fixture();
        try {
            await f.db(scenario.table).update(scenario.values);
            const before = await snapshot(f.db);
            await assert.rejects(down(f.db), /Rollback bloqueado/);
            assert.equal(await f.db.schema.hasColumn('pedidos', 'liberado_cozinha_em'), true);
            assert.equal(await f.db.schema.hasColumn('metodos_pagamento', 'tipo_financeiro'), true);
            assert.deepEqual(await snapshot(f.db), before);
        } finally { await f.close(); }
    });
}

test('migration 001 rollback independently guards an orphan payload hash in damaged historical data', async () => {
    const f = await fixture();
    try {
        // This state is normally impossible: simulate a damaged schema to prove
        // the destructive operation does not rely solely on the pair CHECK.
        await f.db.raw('ALTER TABLE pedidos DROP CONSTRAINT ip_pedido_request_hash');
        await f.db('pedidos').update({ client_payload_hash: 'b'.repeat(64) });
        await f.db.raw("ALTER TABLE pedidos ADD CONSTRAINT ip_pedido_request_hash CHECK ((client_request_id IS NULL AND client_payload_hash IS NULL) OR (client_request_id IS NOT NULL AND client_payload_hash IS NOT NULL AND client_payload_hash ~ '^[a-f0-9]{64}$')) NOT VALID");
        const before = await snapshot(f.db);
        await assert.rejects(down(f.db), /Rollback bloqueado/);
        assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
});

test('migration 001 rollback rejects even untouched defaults and preserves all legacy rows', async () => {
    const f = await fixture();
    try {
        const before = await snapshot(f.db);
        await assert.rejects(down(f.db), /Rollback bloqueado.*forward-only/i);
        assert.equal(await f.db.schema.hasColumn('pedidos', 'fluxo_pagamento'), true);
        assert.equal(await f.db.schema.hasColumn('metodos_pagamento', 'codigo'), true);
        assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
});

test('migration 001 rollback refuses while a concurrent release writer is open and preserves its commit', async () => {
    const f = await fixture();
    let writer;
    try {
        writer = await f.db.transaction();
        await writer('pedidos').where({ id: f.order.id }).update({ liberado_cozinha_em: '2026-10-22T16:00:00Z' });
        await f.db.transaction(async rollbackTrx => {
            // A regressed destructive down would hit this lock timeout rather
            // than hanging the test while the independent writer is open.
            await rollbackTrx.raw("SET LOCAL lock_timeout = '1s'");
            await assert.rejects(down(rollbackTrx), /Rollback bloqueado.*forward-only/i);
        });
        await writer.commit();
        assert.equal(await f.db.schema.hasColumn('pedidos', 'liberado_cozinha_em'), true);
        const order = await f.db('pedidos').where({ id: f.order.id }).first();
        assert.equal(order.liberado_cozinha_em.toISOString(), '2026-10-22T16:00:00.000Z');
    } finally {
        if (writer && !writer.isCompleted()) await writer.rollback();
        await f.close();
    }
});
