import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seed as linkAdministrators} from '../../src/database/seeds/03_vincular_permissoes_ao_admin.js';
import {seed as createMasterAdministrator} from '../../src/database/seeds/09_criar_admin_master.js';

// These two seeds can promote users and write grants. Supply only an in-memory
// store; no database client, URL or real seed runner is involved in this test.
function seedStore({masterExists = true, explicitQz = false} = {}) {
    const rows = {
        usuarios: [
            ...(masterExists ? [{id: 7, email: 'nei@teste.com', nivel_acesso_id: 1, deletado_em: null}] : []),
            {id: 11, email: 'other@invalid.test', nivel_acesso_id: 1, deletado_em: null},
            {id: 22, email: 'employee@invalid.test', nivel_acesso_id: 2, deletado_em: null}
        ],
        permissoes: [
            {id: 101, nome: 'pedidos.visualizar'},
            {id: 102, nome: 'pagamentos.configurar'},
            {id: 103, nome: 'relatorios.visualizar'},
            {id: 104, nome: 'impressao.assinar'},
            {id: 105, nome: 'impressao.visualizar'}
        ],
        permissoes_usuarios: masterExists ? [
            {usuario_id: 7, permissao_id: 101},
            ...(explicitQz ? [{usuario_id: 7, permissao_id: 104}] : [])
        ] : []
    };
    function knex(table) {
        assert.ok(Object.hasOwn(rows, table), 'unexpected seed table: ' + table);
        const predicates = [];
        let write;
        const matching = () => rows[table].filter(row => predicates.every(predicate => predicate(row)));
        const project = (records, columns) => records.map(row => columns ?
            Object.fromEntries(columns.map(column => [column, row[column]])) : {...row});
        function execute(ignoreDuplicates = false) {
            if (!write) return matching();
            if (write.operation === 'update') {
                const updated = matching();
                updated.forEach(row => Object.assign(row, write.data));
                return updated;
            }
            return write.data.flatMap(data => {
                if (table === 'permissoes_usuarios' && rows[table].some(row =>
                    row.usuario_id === data.usuario_id && row.permissao_id === data.permissao_id)) {
                    if (ignoreDuplicates) return [];
                    throw new Error('Duplicate synthetic permission grant');
                }
                const row = table === 'usuarios' ? {id: 1 + Math.max(0, ...rows[table].map(row => row.id)), ...data} : {...data};
                rows[table].push(row);
                return [row];
            });
        }
        const query = {
            where(values) { predicates.push(row => Object.entries(values).every(([key, value]) => row[key] === value)); return query; },
            whereNot(column, value) { predicates.push(row => row[column] !== value); return query; },
            whereRaw(sql, bindings) {
                assert.equal(table, 'usuarios'); assert.equal(sql, 'LOWER(email) = ?');
                predicates.push(row => row.email.toLowerCase() === bindings[0]); return query;
            },
            async select(...columns) { return project(matching(), columns); },
            async first() { return project(matching())[0]; },
            insert(data) { write = {operation: 'insert', data: Array.isArray(data) ? data : [data]}; return query; },
            update(data) { write = {operation: 'update', data}; return query; },
            async returning(columns) { return project(execute(), columns); },
            onConflict(columns) { assert.deepEqual(columns, ['usuario_id', 'permissao_id']); return query; },
            async ignore() { return execute(true); },
            then(resolve, reject) { return Promise.resolve().then(() => execute()).then(resolve, reject); }
        };
        return query;
    }
    knex.transaction = async operation => operation(knex);
    knex.fn = {now: () => new Date('2050-01-01T00:00:00Z')};
    return {knex, rows, granted: id => rows.permissoes_usuarios.filter(row => row.usuario_id === id)
        .map(row => rows.permissoes.find(permission => permission.id === row.permissao_id).nome).sort()};
}

const automaticPermissions = ['impressao.visualizar', 'pagamentos.configurar', 'pedidos.visualizar', 'relatorios.visualizar'];

function syntheticSeedPassword(t) {
    const previous = process.env.SEED_ADMIN_PASSWORD;
    process.env.SEED_ADMIN_PASSWORD = 'SYNTHETIC-QZ-GRANT-TEST-ONLY';
    t.after(() => {
        if (previous === undefined) delete process.env.SEED_ADMIN_PASSWORD;
        else process.env.SEED_ADMIN_PASSWORD = previous;
    });
}

test('admin linkage seed preserves every historical automatic grant while excluding QZ signing', async t => {
    t.mock.method(console, 'log', () => {});
    const store = seedStore();
    await linkAdministrators(store.knex); await linkAdministrators(store.knex);
    assert.deepEqual(store.granted(7), automaticPermissions);
    assert.deepEqual(store.granted(11), automaticPermissions);
    assert.deepEqual(store.granted(22), []);
});

test('admin linkage seed retains a prior explicit QZ grant without copying it to other administrators', async t => {
    t.mock.method(console, 'log', () => {});
    const store = seedStore({explicitQz: true});
    await linkAdministrators(store.knex);
    assert.deepEqual(store.granted(7), ['impressao.assinar', ...automaticPermissions]);
    assert.deepEqual(store.granted(11), automaticPermissions);
});

for (const masterExists of [true, false]) {
    test('master admin seed requires explicit QZ permission for ' + (masterExists ? 'an existing' : 'a newly created') + ' admin', async t => {
        t.mock.method(console, 'log', () => {});
        syntheticSeedPassword(t);
        const store = seedStore({masterExists});
        await createMasterAdministrator(store.knex); await createMasterAdministrator(store.knex);
        const master = store.rows.usuarios.find(row => row.email === 'nei@teste.com');
        assert.deepEqual(store.granted(master.id), automaticPermissions);
        assert.deepEqual(store.granted(11), []);
        assert.deepEqual(store.granted(22), []);
    });
}

test('master admin seed preserves an explicit QZ grant already approved for that user', async t => {
    t.mock.method(console, 'log', () => {});
    syntheticSeedPassword(t);
    const store = seedStore({explicitQz: true});
    await createMasterAdministrator(store.knex);
    assert.deepEqual(store.granted(7), ['impressao.assinar', ...automaticPermissions]);
    assert.deepEqual(store.granted(11), []);
});
