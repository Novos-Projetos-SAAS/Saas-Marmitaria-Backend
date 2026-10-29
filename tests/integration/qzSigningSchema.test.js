import {describe, test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {createTestDatabase, migrations, historicalOrder} from '../helpers/testDatabase.js';

const migrationName = '20261028000200_qz_assinatura_protegida.js';
const tables = ['qz_proto_estacoes', 'qz_proto_documentos', 'qz_proto_intencoes', 'qz_proto_auditoria'];
const hash = () => randomBytes(32).toString('hex');
const created = new Date('2050-01-01T00:00:00Z');
const expires = new Date('2050-01-01T00:00:15Z');

describe('protected QZ signing additive schema', {concurrency: false}, () => {
    let fixture, db, actor, method;
    before(async () => {
        fixture = await createTestDatabase(); db = fixture.db;
        await db.migrate.latest();
        const [role] = await db('niveis_acesso').insert({nome: 'admin', descricao: 'SYNTHETIC ONLY'}).returning('*');
        [actor] = await db('usuarios').insert({nome: 'SYNTHETIC', email: 'qz-schema@invalid.test',
            senha_hash: 'SYNTHETIC-NOT-A-CREDENTIAL', nivel_acesso_id: role.id}).returning('*');
        [method] = await db('metodos_pagamento').insert({nome: 'SYNTHETIC CASH'}).returning('*');
    });
    after(async () => { if (fixture) await fixture.close(); });

    async function station(overrides = {}) {
        const [row] = await db('qz_proto_estacoes').insert({id: randomUUID(), usuario_id: actor.id,
            impressora: 'SYNTHETIC_PRINTER', ...overrides}).returning('*');
        return row;
    }
    async function documentData(overrides = {}) {
        const s = await station();
        const [order] = await db('pedidos').insert({nome_cliente: 'SYNTHETIC QZ', telefone_cliente: '00000000000',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: 1}).returning('*');
        return {id: randomUUID(), estacao_id: s.id, pedido_id: order.id, params: {printer: {name: s.impressora}},
            source_hash: hash(), expira_em: expires, ...overrides};
    }
    async function intentData(overrides = {}) {
        const s = await station();
        return {id: randomUUID(), usuario_id: actor.id, sessao_hash: hash(), estacao_id: s.id,
            documento_id: null, chamada: 'printers.find', request_digest: hash(), params_hash: hash(),
            operacao_hash: hash(), request_timestamp: created.getTime(), estado: 'RESERVADA',
            criado_em: created, expira_em: expires, ...overrides};
    }
    function auditData(overrides = {}) {
        return {usuario_id: actor.id, intencao_id: null, operacao: 'SIGN', decisao: 'DENY',
            codigo: 'QZ_AUTH_DENIED', criado_em: created, ...overrides};
    }

    test('latest migrations create empty QZ storage and register an ungranted permission', async () => {
        for (const table of tables) {
            assert.equal(await db.schema.hasTable(table), true, table);
            assert.equal(Number((await db(table).count('* as n').first()).n), 0, table);
        }
        const permissions = await db('permissoes').where({nome: 'impressao.assinar'});
        assert.equal(permissions.length, 1);
        assert.equal(Number((await db('permissoes_usuarios').where({permissao_id: permissions[0].id}).count('* as n').first()).n), 0);
        assert.deepEqual((await db.migrate.latest())[1], []);
    });

    test('storage persists the original document and all three one-use intent states', async () => {
        const doc = await documentData();
        await db('qz_proto_documentos').insert(doc);
        const print = await intentData({estacao_id: doc.estacao_id, documento_id: doc.id, chamada: 'print'});
        await db('qz_proto_intencoes').insert(print);
        for (const estado of ['RESERVADA', 'CONSUMIDA', 'ASSINADA']) {
            await db('qz_proto_intencoes').where({id: print.id}).update({estado});
            assert.equal((await db('qz_proto_intencoes').where({id: print.id}).first()).estado, estado);
        }
        assert.deepEqual((await db('qz_proto_documentos').where({id: doc.id}).first()).params, doc.params);
        await db('qz_proto_auditoria').insert(auditData({intencao_id: print.id}));
        await db('qz_proto_auditoria').insert(auditData({usuario_id: null, intencao_id: null}));
    });

    for (const field of ['sessao_hash', 'request_digest', 'params_hash', 'operacao_hash']) {
        for (const invalid of ['a'.repeat(63), 'g'.repeat(64)]) {
            test('intent rejects malformed ' + field + ' (' + invalid.length + ' characters)', async () => {
                await assert.rejects(db('qz_proto_intencoes').insert(await intentData({[field]: invalid})), {code: '23514'});
            });
        }
    }
    for (const invalid of ['a'.repeat(63), 'g'.repeat(64)]) {
        test('document rejects malformed source_hash (' + invalid.length + ' characters)', async () => {
            await assert.rejects(db('qz_proto_documentos').insert(await documentData({source_hash: invalid})), {code: '23514'});
        });
    }
    test('intent rejects unsupported calls independently of its state', async () => {
        await assert.rejects(db('qz_proto_intencoes').insert(await intentData({chamada: 'files.write'})), {code: '23514'});
    });
    test('intent rejects an unrecognized state independently of its call', async () => {
        await assert.rejects(db('qz_proto_intencoes').insert(await intentData({estado: 'RETRY'})), {code: '23514'});
    });
    test('station identifiers must be UUIDs', async () => {
        await assert.rejects(station({id: 'not-a-uuid'}), {code: '22P02'});
    });
    test('a digest cannot be prepared again for another station', async () => {
        const first = await intentData();
        await db('qz_proto_intencoes').insert(first);
        await assert.rejects(db('qz_proto_intencoes').insert(await intentData({request_digest: first.request_digest})), {code: '23505'});
    });
    test('a document cannot acquire a second print intention', async () => {
        const doc = await documentData(); await db('qz_proto_documentos').insert(doc);
        await db('qz_proto_intencoes').insert(await intentData({documento_id: doc.id, chamada: 'print', estacao_id: doc.estacao_id}));
        await assert.rejects(db('qz_proto_intencoes').insert(await intentData({documento_id: doc.id, chamada: 'print', estacao_id: doc.estacao_id})), {code: '23505'});
    });
    test('the same order cannot create a second original document at another station', async () => {
        const doc = await documentData(); await db('qz_proto_documentos').insert(doc);
        const secondStation = await station();
        await assert.rejects(db('qz_proto_documentos').insert({...doc, id: randomUUID(), estacao_id: secondStation.id}), {code: '23505'});
    });
    test('discovery intentions may independently omit a print document', async () => {
        await db('qz_proto_intencoes').insert(await intentData());
        await db('qz_proto_intencoes').insert(await intentData());
    });

    for (const [table, field, invalid] of [
        ['qz_proto_estacoes', 'usuario_id', 2147483647],
        ['qz_proto_documentos', 'estacao_id', '00000000-0000-4000-8000-000000000001'],
        ['qz_proto_documentos', 'pedido_id', 2147483647],
        ['qz_proto_intencoes', 'usuario_id', 2147483647],
        ['qz_proto_intencoes', 'estacao_id', '00000000-0000-4000-8000-000000000001'],
        ['qz_proto_intencoes', 'documento_id', '00000000-0000-4000-8000-000000000001'],
        ['qz_proto_auditoria', 'usuario_id', 2147483647],
        ['qz_proto_auditoria', 'intencao_id', '00000000-0000-4000-8000-000000000001']
    ]) {
        test(table + '.' + field + ' refuses an absent parent', async () => {
            if (table === 'qz_proto_estacoes') return assert.rejects(station({[field]: invalid}), {code: '23503'});
            const data = table === 'qz_proto_documentos' ? await documentData() :
                table === 'qz_proto_intencoes' ? await intentData() : auditData();
            await assert.rejects(db(table).insert({...data, [field]: invalid}), {code: '23503'});
        });
    }
    test('deletes preserve all linked actors, stations, orders, documents and audited intentions', async () => {
        const doc = await documentData(); await db('qz_proto_documentos').insert(doc);
        const intent = await intentData({documento_id: doc.id, chamada: 'print', estacao_id: doc.estacao_id});
        await db('qz_proto_intencoes').insert(intent);
        await db('qz_proto_auditoria').insert(auditData({intencao_id: intent.id}));
        for (const [table, id] of [['usuarios', actor.id], ['pedidos', doc.pedido_id],
            ['qz_proto_estacoes', doc.estacao_id], ['qz_proto_documentos', doc.id], ['qz_proto_intencoes', intent.id]]) {
            await assert.rejects(db(table).where({id}).del(), error =>
                error.code === '23001' && error.constraint?.startsWith('qz_proto_'));
            assert.ok(await db(table).where({id}).first(), table);
        }
        const links = (await db.raw(`SELECT c.confdeltype FROM pg_constraint c
            JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
            WHERE n.nspname=? AND r.relname=ANY(?::text[]) AND c.contype='f'`, [fixture.schema, tables])).rows;
        assert.equal(links.length, 8);
        assert.ok(links.every(link => link.confdeltype === 'r'), 'every QZ FK explicitly restricts deletion');
    });
    test('audit and intent access paths are indexed for actor, station and expiry', async () => {
        const indexes = (await db.raw('SELECT tablename, indexdef FROM pg_indexes WHERE schemaname=?', [fixture.schema])).rows;
        for (const [table, columns] of [
            ['qz_proto_auditoria', '(usuario_id, criado_em)'], ['qz_proto_auditoria', '(intencao_id)'],
            ['qz_proto_intencoes', '(usuario_id, criado_em)'], ['qz_proto_intencoes', '(estacao_id, criado_em)'],
            ['qz_proto_intencoes', '(expira_em)']
        ]) assert.ok(indexes.some(index => index.tablename === table && index.indexdef.includes(columns)), table + columns);
    });
    test('official rollback refuses before removing rows, links, permissions or migration history', async () => {
        const snapshot = async () => {
            const rows = {};
            for (const table of [...tables, 'permissoes', 'permissoes_usuarios', 'knex_migrations']) rows[table] = await db(table).orderBy('id');
            rows.constraints = (await db.raw(`SELECT r.relname, c.conname, pg_get_constraintdef(c.oid) AS definition
                FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
                WHERE n.nspname=? ORDER BY r.relname, c.conname`, [fixture.schema])).rows;
            rows.indexes = (await db.raw('SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname=? ORDER BY tablename, indexname', [fixture.schema])).rows;
            return rows;
        };
        const before = await snapshot(), queries = [], listener = query => queries.push(query.sql);
        db.on('query', listener);
        try { await assert.rejects(db.migrate.down({name: migrationName}), /Rollback bloqueado.*forward-only.*dados.*estrutura/i); }
        finally { db.removeListener('query', listener); }
        assert.deepEqual(queries.filter(sql => /^\s*(DROP|TRUNCATE|DELETE)\b/i.test(sql) || /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql)), []);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual((await db.migrate.latest())[1], []);
        assert.equal((await db('knex_migrations_lock').first()).is_locked, 0);
    });
});

describe('protected QZ migration preserves preexisting history', {concurrency: false}, () => {
    test('the additive upgrade keeps historical orders and explicit grants without granting QZ to administrators', async () => {
        const f = await createTestDatabase();
        try {
            for (const name of (await readdir(migrations)).filter(name => name.endsWith('.js') && name < migrationName).sort()) {
                await f.db.migrate.up({name});
            }
            await historicalOrder(f.db, {id: 901, methodId: 91});
            const [role] = await f.db('niveis_acesso').insert({nome: 'admin', descricao: 'SYNTHETIC'}).returning('*');
            const [actor] = await f.db('usuarios').insert({nome: 'SYNTHETIC', email: 'qz-old@invalid.test',
                senha_hash: 'SYNTHETIC', nivel_acesso_id: role.id}).returning('*');
            const [permission] = await f.db('permissoes').insert({nome: 'impressao.assinar', descricao: 'PREEXISTING EXPLICIT CATALOG ENTRY'}).returning('*');
            const [legacy] = await f.db('permissoes').insert({nome: 'legacy.explicit', descricao: 'SYNTHETIC'}).returning('*');
            await f.db('permissoes_usuarios').insert({usuario_id: actor.id, permissao_id: legacy.id});
            const previous = {};
            for (const table of ['pedidos', 'itens_pedido', 'usuarios', 'niveis_acesso', 'permissoes', 'permissoes_usuarios']) previous[table] = await f.db(table).orderBy('id');
            const history = await f.db('knex_migrations').orderBy('id');
            const applied = await f.db.migrate.latest();
            assert.deepEqual(applied[1], [migrationName]);
            for (const table of Object.keys(previous)) assert.deepEqual(await f.db(table).orderBy('id'), previous[table], table);
            assert.deepEqual(await f.db('permissoes').where({nome: 'impressao.assinar'}).first(), permission);
            assert.equal(Number((await f.db('permissoes_usuarios').where({permissao_id: permission.id}).count('* as n').first()).n), 0);
            assert.deepEqual((await f.db('knex_migrations').orderBy('id')).slice(0, -1), history);
        } finally { await f.close(); }
    });
});
