import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { definirFluxoCriacao } from '../../src/utils/pedidoPaymentPolicy.js';
import { createTestDatabase, migrateBaseline, migrateInfinitepayFoundation } from '../helpers/testDatabase.js';

const migrationName = '20261023000100_classificar_metodos_pagamento_aprovados.js';
const approved = [
    { id: 1, nome: 'Pix', codigo: 'PIX', tipo_financeiro: 'PIX' },
    { id: 2, nome: 'Dinheiro', codigo: 'DINHEIRO', tipo_financeiro: 'DINHEIRO' },
    { id: 3, nome: 'Cartão de Crédito', codigo: 'CARTAO_CREDITO', tipo_financeiro: 'CREDITO' },
    { id: 4, nome: 'Cartão de Débito', codigo: 'CARTAO_DEBITO', tipo_financeiro: 'DEBITO' }
];
describe('approved real payment identity map on synthetic PostgreSQL data', { concurrency: false }, () => {
    let f, db;
    beforeEach(async () => {
        f = await createTestDatabase(); db = f.db;
        await migrateBaseline(db); await migrateInfinitepayFoundation(db);
    });
    afterEach(async () => { if (f) await f.close(); });
    async function migration() {
        try { return await import('../../src/database/migrations/' + migrationName); }
        catch (error) { assert.fail('Migration aprovada ausente: ' + error.code); }
    }
    async function seedMethods() {
        await db('metodos_pagamento').insert(approved.map(({ id, nome }) => ({ id, nome, ativo: true,
            criado_em: '2025-04-01T12:00:00Z', atualizado_em: '2025-04-01T12:00:00Z' })));
    }
    async function state() {
        const tables = (await db.raw("SELECT tablename FROM pg_tables WHERE schemaname=? ORDER BY tablename", [f.schema])).rows.map(row => row.tablename);
        const rows = {};
        for (const table of tables) rows[table] = (await db(table).select('*')).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const schema = (await db.raw(`SELECT c.relname, x.contype, x.conname, pg_get_constraintdef(x.oid) AS definition
            FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=? ORDER BY c.relname,x.conname`, [f.schema])).rows;
        const indexes = (await db.raw('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=? ORDER BY tablename,indexname', [f.schema])).rows;
        const columns = (await db.raw(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
            WHERE table_schema=? ORDER BY table_name,ordinal_position`, [f.schema])).rows;
        return { tables, schema, indexes, columns, rows };
    }
    function queries() {
        const sql = []; const listener = query => sql.push(query.sql); db.on('query', listener);
        return { sql, stop: () => db.removeListener('query', listener) };
    }
    async function assertRefused() {
        const before = await state(); const observed = queries();
        try { await assert.rejects((await migration()).up(db), /Backfill bloqueado/i); }
        finally { observed.stop(); }
        assert.deepEqual(observed.sql.filter(query => /^\s*update\b/i.test(query)), [], 'all identities validated before any update');
        assert.deepEqual(await state(), before);
    }
    test('maps exactly the approved IDs and preserves every order, item, financial row and unrelated method', async () => {
        await seedMethods();
        await db('metodos_pagamento').insert([{ id: 17, nome: 'Método personalizado', codigo: 'CUSTOM_17', tipo_financeiro: 'OUTRO' },
            { id: 29, nome: 'Pix personalizado', ativo: false, codigo: null, tipo_financeiro: 'OUTRO' }]);
        const [size] = await db('tamanhos_marmitas').insert({ nome: 'M histórico sintético', preco_base: '99.99' }).returning('*');
        for (const method of approved) {
            const [order] = await db('pedidos').insert({ nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
                tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id,
                status: 'Entregue', valor_total: '20.00' }).returning('*');
            await db('itens_pedido').insert({ pedido_id: order.id, tamanho_marmita_id: size.id, quantidade: 2,
                preco_unitario: '10.00', subtotal: '20.00', nome_item_snapshot: 'Nome histórico', observacao: 'Sem molho' });
            if (method.id === 1) {
                await db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1, order_nsu: 'SYNTHETIC-HISTORY',
                    status: 'INCERTA', valor_centavos: 2000, valid_until: '2026-10-24T02:59:59Z' });
            }
        }
        const before = await state(); const observed = queries();
        try { await db.migrate.up({ name: migrationName }); } finally { observed.stop(); }
        const after = await state();
        assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.schema, before.schema);
        assert.deepEqual(after.indexes, before.indexes); assert.deepEqual(after.columns, before.columns);
        for (const [table, rows] of Object.entries(before.rows)) {
            if (['metodos_pagamento', 'knex_migrations', 'knex_migrations_lock'].includes(table)) continue;
            assert.deepEqual(after.rows[table], rows, table);
        }
        const mapped = await db('metodos_pagamento').whereIn('id', [1, 2, 3, 4]).orderBy('id');
        assert.deepEqual(mapped.map(({ id, nome, codigo, tipo_financeiro }) => ({ id, nome, codigo, tipo_financeiro })), approved);
        for (const metodo of mapped) {
            for (const [habilitado, configAtiva] of [[false, false], [false, true], [true, false]]) {
                assert.equal(definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado, configAtiva }), 'POSTERIOR');
            }
            assert.equal(definirFluxoCriacao({ origem: 'ADMIN', metodo, habilitado: true, configAtiva: true }), 'POSTERIOR');
            if (['PIX', 'CREDITO'].includes(metodo.tipo_financeiro)) {
                assert.throws(() => definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado: true, configAtiva: true }), error => error.statusCode === 503);
            } else {
                assert.equal(definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado: true, configAtiva: true }), 'POSTERIOR');
            }
        }
        for (const row of mapped) {
            const original = before.rows.metodos_pagamento.find(item => item.id === row.id);
            for (const key of Object.keys(original).filter(key => !['codigo', 'tipo_financeiro', 'atualizado_em'].includes(key))) {
                assert.deepEqual(row[key], original[key], key);
            }
        }
        for (const id of [17, 29]) assert.deepEqual(await db('metodos_pagamento').where({ id }).first(), before.rows.metodos_pagamento.find(row => row.id === id));
        assert.deepEqual(observed.sql.filter(query => /^\s*(DROP|DELETE|TRUNCATE)\b/i.test(query) || /^\s*ALTER\b/i.test(query)), []);
        assert.equal((await db('knex_migrations').where({ name: migrationName }).first()).name, migrationName);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
    });
    test('reapplying identical classifications performs no updates and preserves timestamps', async () => {
        await seedMethods(); const mod = await migration(); await mod.up(db);
        const before = await state(); const observed = queries();
        try { await mod.up(db); } finally { observed.stop(); }
        assert.deepEqual(observed.sql.filter(query => /^\s*update\b/i.test(query)), []);
        assert.deepEqual(await state(), before);
    });
    test('empty installation creates no payment methods and keeps the integration disabled', async () => {
        await db.migrate.up({ name: migrationName });
        assert.deepEqual(await db('metodos_pagamento').select('*'), []);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
    });
    for (const [label, id, change] of [
        ['wrong ID/name correspondence', 4, { nome: 'Débito renomeado antes da aprovação' }],
        ['inactive approved method', 3, { ativo: false }],
        ['soft-deleted approved method', 2, { deletado_em: '2026-10-01T12:00:00Z' }],
        ['conflicting technical code', 3, { codigo: 'CREDITO', tipo_financeiro: 'CREDITO' }],
        ['conflicting type despite null code', 1, { tipo_financeiro: 'DEBITO' }],
        ['conflicting type despite matching code', 3, { codigo: 'CARTAO_CREDITO', tipo_financeiro: 'PIX' }],
        ['nondefault empty code', 4, { codigo: '' }]
    ]) {
        test('fails before updates for ' + label, async () => {
            await seedMethods(); await db('metodos_pagamento').where({ id }).update(change); await assertRefused();
        });
    }
    test('partial presence of the approved IDs blocks the migration instead of guessing another ID', async () => {
        await db('metodos_pagamento').insert(approved.filter(row => row.id !== 3).map(({ id, nome }) => ({ id, nome })));
        await db('metodos_pagamento').insert({ id: 99, nome: 'Cartão de Crédito' }); await assertRefused();
    });
    test('a nonempty database with no approved IDs is rejected without touching custom methods', async () => {
        await db('metodos_pagamento').insert({ id: 99, nome: 'Método personalizado', codigo: 'CUSTOM_99' }); await assertRefused();
    });
    test('a target code held by any custom row blocks every update without reassigning the custom row', async () => {
        await seedMethods(); await db('metodos_pagamento').insert({ id: 99, nome: 'Personalizado', codigo: 'PIX', ativo: false }); await assertRefused();
    });
    test('compatible partial classifications are completed only after identity validation', async () => {
        await seedMethods();
        await db('metodos_pagamento').where({ id: 1 }).update({ tipo_financeiro: 'PIX' });
        await db('metodos_pagamento').where({ id: 3 }).update({ codigo: 'CARTAO_CREDITO' });
        await (await migration()).up(db);
        assert.deepEqual((await db('metodos_pagamento').whereIn('id', [1, 2, 3, 4]).orderBy('id')).map(({ id, nome, codigo, tipo_financeiro }) => ({ id, nome, codigo, tipo_financeiro })), approved);
    });
    test('a write failure rolls back classifications applied earlier in the same migration', async () => {
        await seedMethods();
        await db.raw(`CREATE FUNCTION block_synthetic_classification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.id=3 THEN RAISE EXCEPTION 'SYNTHETIC_WRITE_REJECTED'; END IF; RETURN NEW; END $$`);
        await db.raw('CREATE TRIGGER block_synthetic_classification BEFORE UPDATE ON metodos_pagamento FOR EACH ROW EXECUTE FUNCTION block_synthetic_classification()');
        const before = await state();
        await assert.rejects((await migration()).up(db), /SYNTHETIC_WRITE_REJECTED/);
        assert.deepEqual(await state(), before);
    });
    test('official Knex rollback is forward-only and preserves data and migration history', async () => {
        await seedMethods(); await db.migrate.up({ name: migrationName }); const before = await state();
        await assert.rejects(db.migrate.down({ name: migrationName }), /Rollback bloqueado.*forward-only/i);
        assert.deepEqual(await state(), before);
    });
    test('concurrent invocations serialize and leave exactly the four approved pairs', async () => {
        await seedMethods(); const mod = await migration();
        await Promise.all([mod.up(db), mod.up(db)]);
        assert.deepEqual((await db('metodos_pagamento').orderBy('id')).map(({ id, nome, codigo, tipo_financeiro }) => ({ id, nome, codigo, tipo_financeiro })), approved);
    });
    test('previous main schema and the five InfinitePay migrations apply together to the approved historical methods', async () => {
        const historical = await createTestDatabase();
        try {
            await migrateBaseline(historical.db);
            await historical.db('metodos_pagamento').insert(approved.map(({ id, nome }) => ({ id, nome, ativo: true })));
            const applied = await historical.db.migrate.latest();
            assert.equal(applied[1].length, 5);
            assert.equal(applied[1].at(-1), migrationName);
            const rows = await historical.db('metodos_pagamento').orderBy('id');
            assert.deepEqual(rows.map(({ id, nome, codigo, tipo_financeiro }) => ({ id, nome, codigo, tipo_financeiro })), approved);
            assert.equal((await historical.db('config_infinitepay').first()).ativo, false);
        } finally { await historical.close(); }
    });
    test('official Knex up rejects identity drift without recording the migration or partially changing classifications', async () => {
        await seedMethods(); await db('metodos_pagamento').where({ id: 4 }).update({ nome: 'Nome não aprovado' });
        const before = await state();
        await assert.rejects(db.migrate.up({ name: migrationName }), /Backfill bloqueado/i);
        assert.deepEqual(await state(), before);
        assert.equal(await db('knex_migrations').where({ name: migrationName }).first(), undefined);
    });
});
