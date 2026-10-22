import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../helpers/testDatabase.js';

test('all migrations install on an empty isolated PostgreSQL with integration disabled', async () => {
    const fixture = await createTestDatabase();
    try {
        await fixture.db.migrate.latest();
        assert.equal(await fixture.db.schema.hasTable('config_infinitepay'), true);
        const config = await fixture.db('config_infinitepay').where({ id: 1 }).first();
        assert.equal(config.ativo, false);
        assert.equal(config.assured_installments, 1);
        await assert.rejects(fixture.db('config_infinitepay').where({id:1}).update({ativo:true}), {code:'23514'});
        await assert.rejects(fixture.db('config_infinitepay').where({id:1}).update({assured_installments:13}), {code:'23514'});
        await assert.rejects(fixture.db('config_infinitepay').insert({id:2}), {code:'23514'});
        for (const name of ['pagamentos', 'pagamentos_eventos', 'pedido_acessos', 'outbox_eventos', 'infinitepay_credenciais']) {
            assert.equal(await fixture.db.schema.hasTable(name), true, name);
        }
    } finally { await fixture.close(); }
});
