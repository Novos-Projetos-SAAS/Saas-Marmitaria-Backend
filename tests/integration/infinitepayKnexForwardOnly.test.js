import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrateBaseline, migrateInfinitepayFoundation, historicalOrder } from '../helpers/testDatabase.js';

const names = [
    '20261022000100_infinitepay_metodos_pedidos.js',
    '20261022000200_infinitepay_config_credenciais.js',
    '20261022000300_infinitepay_pagamentos_eventos_acessos_outbox.js',
    '20261022000400_infinitepay_permissoes.js'
];
let fixture;
before(async () => {
    fixture = await createTestDatabase();
    await fixture.db.migrate.latest();
    await historicalOrder(fixture.db);
});
after(async () => { if (fixture) await fixture.close(); });

function collectQueries(db) {
    const queries = [];
    const listener = query => queries.push(query.sql);
    db.on('query', listener);
    return { queries, stop: () => db.removeListener('query', listener) };
}
function assertNoRemoval(queries) {
    assert.deepEqual(queries.filter(sql => /^\s*(DROP|TRUNCATE|DELETE)\b/i.test(sql) ||
        /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql)), []);
}
async function state(db, schema) {
    const tables = (await db.raw("SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY table_name", [schema])).rows.map(row => row.table_name);
    const columns = (await db.raw(`SELECT table_name, column_name, ordinal_position, data_type,
        udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema=? ORDER BY table_name, ordinal_position`, [schema])).rows;
    const constraints = (await db.raw(`SELECT r.relname AS table_name, c.conname AS name,
        c.contype AS type, pg_get_constraintdef(c.oid, true) AS definition
        FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=?
        ORDER BY r.relname, c.conname`, [schema])).rows;
    const indexes = (await db.raw(`SELECT tablename AS table_name, indexname AS name, indexdef AS definition
        FROM pg_indexes WHERE schemaname=? ORDER BY tablename, indexname`, [schema])).rows;
    const rows = {};
    for (const table of tables) {
        rows[table] = (await db(table).select('*')).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return { tables, columns, constraints, indexes, rows };
}
async function assertOfficialRefusal(action) {
    const { db, schema } = fixture;
    const before = await state(db, schema);
    const observed = collectQueries(db);
    try { await assert.rejects(action, /Rollback bloqueado.*forward-only.*dados.*estrutura/i); }
    finally { observed.stop(); }
    assertNoRemoval(observed.queries);
    assert.deepEqual(await state(db, schema), before, 'data, schema, indexes, constraints and migration history unchanged');
    assert.equal((await db('knex_migrations_lock').first()).is_locked, 0);
    const latest = await db.migrate.latest();
    assert.deepEqual(latest[1], [], 'failed down must not make any migration pending again');
    assert.deepEqual(await db('knex_migrations').select('*').orderBy('id'), before.rows.knex_migrations.slice().sort((a, b) => a.id - b.id));
}

for (const name of names) {
    test('official Knex migrate.down blocks ' + name + ' without partial effects or history deletion', async () => {
        await assertOfficialRefusal(() => fixture.db.migrate.down({ name }));
    });
}
test('official Knex batch rollback refuses before removing schema, permissions or migration records', async () => {
    await assertOfficialRefusal(() => fixture.db.migrate.rollback());
});
test('official Knex rollback all stops at InfinitePay and never reaches historical main downs', async () => {
    await assertOfficialRefusal(() => fixture.db.migrate.rollback({}, true));
});

test('the four unchanged ups preserve every existing table, column, FK, index, ID and historical row', async () => {
    const f = await createTestDatabase();
    try {
        await migrateBaseline(f.db);
        await historicalOrder(f.db, { id: 701, methodId: 91 });
        await f.db('niveis_acesso').insert({ id: 1, nome: 'admin', descricao: 'Sintético', ativo: true });
        await f.db('usuarios').insert({ id: 1, nome: 'Usuário histórico sintético', email: 'historico@invalid.test',
            senha_hash: 'SYNTHETIC-NOT-A-CREDENTIAL', nivel_acesso_id: 1, ativo: true });
        const [permission] = await f.db('permissoes').insert({ nome: 'legacy.permission', descricao: 'Sintética anterior' }).returning('id');
        await f.db('permissoes_usuarios').insert({ usuario_id: 1, permissao_id: permission.id });
        const before = await state(f.db, f.schema);
        const observed = collectQueries(f.db);
        let applied;
        try { applied = await migrateInfinitepayFoundation(f.db); }
        finally { observed.stop(); }
        assert.deepEqual(applied, names);
        assertNoRemoval(observed.queries);
        const after = await state(f.db, f.schema);
        for (const table of before.tables) assert.equal(after.tables.includes(table), true, table);
        for (const section of ['columns', 'constraints', 'indexes']) {
            for (const record of before[section]) {
                assert.equal(after[section].some(candidate => JSON.stringify(candidate) === JSON.stringify(record)), true,
                    section + ': ' + JSON.stringify(record));
            }
        }
        for (const [table, oldRows] of Object.entries(before.rows)) {
            if (!oldRows.length) continue;
            const keys = Object.keys(oldRows[0]);
            const remaining = after.rows[table].map(row => JSON.stringify(Object.fromEntries(keys.map(key => [key, row[key]]))));
            for (const row of oldRows) {
                const index = remaining.indexOf(JSON.stringify(row));
                assert.notEqual(index, -1, table + ': preexisting row preserved');
                remaining.splice(index, 1);
            }
        }
        assert.equal((await f.db('config_infinitepay').where({ id: 1 }).first()).ativo, false);
        assert.equal((await f.db('pedidos').where({ id: 701 }).first()).metodo_pagamento_id, 91);
        assert.equal((await f.db('itens_pedido').where({ pedido_id: 701 }).first()).subtotal, '20.00');
    } finally { await f.close(); }
});
