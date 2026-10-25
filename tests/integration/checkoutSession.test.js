import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';

describe('persistent checkout ownership established before order creation', () => {
    let fixture, db, service, clock, owner;
    beforeEach(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
        clock = new Date('2026-10-24T15:00:00Z');
        const { createCheckoutSessionService } = await import('../../src/services/checkoutSessionService.js');
        service = createCheckoutSessionService({ db, now: () => new Date(clock) });
        owner = await service.open();
    });
    afterEach(async () => { await fixture?.close(); });
    const input = { nome_cliente: 'SYNTHETIC', marmitas: [{ tamanho_id: 1, quantidade: 1 }] };
    async function save(session = owner, payload = input) {
        return db.transaction(async trx => {
            const reserved = await service.lockCreation(trx, session.session_token, session.client_request_id, payload);
            if (reserved.replay) return reserved.pedidoId;
            const [method] = await trx('metodos_pagamento').insert({ nome: 'Synthetic cash' }).returning('id');
            const [order] = await trx('pedidos').insert({ nome_cliente: 'SYNTHETIC', telefone_cliente: '00000000000',
                tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: 1 }).returning('id');
            await service.attach(trx, reserved, order.id); return order.id;
        });
    }
    test('bootstrap is durable and contains only hashed ownership at rest', async () => {
        assert.match(owner.session_token, /^[A-Za-z0-9_-]{43}$/);
        assert.match(owner.csrf_token, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(owner.session_token, owner.csrf_token);
        assert.deepEqual(await service.open(owner.session_token), owner);
        assert.doesNotMatch(JSON.stringify(await db('checkout_sessoes')), new RegExp(owner.session_token));
        assert.equal(Number((await db('pedidos').count('* as n').first()).n), 0);
    });
    test('a lost creation response and reopened browser recover the same order without recreating it', async () => {
        const id = await save();
        const recovered = await service.lookup(owner.session_token);
        assert.equal(recovered.pedido_id, id); assert.equal(recovered.fluxo_pagamento, 'POSTERIOR');
        assert.equal(await save(), id); assert.equal(Number((await db('pedidos').count('* as n').first()).n), 1);
    });
    test('two tabs and concurrent requests share a single durable intention and order', async () => {
        const tabs = await Promise.all(Array.from({ length: 5 }, () => service.open(owner.session_token)));
        assert.equal(new Set(tabs.map(tab => tab.client_request_id)).size, 1);
        assert.equal(new Set(await Promise.all(tabs.map(tab => save(tab)))).size, 1);
    });
    test('payload changes, another session and a UUID alone cannot recover or mutate an order', async () => {
        await save(); const stranger = await service.open();
        await assert.rejects(save(owner, { ...input, nome_cliente: 'OTHER' }), error => error.statusCode === 409);
        await assert.rejects(service.lookup(stranger.session_token, owner.client_request_id), error => error.statusCode === 404);
        await assert.rejects(service.lookup(owner.client_request_id), error => error.statusCode === 404);
        await assert.rejects(service.lookup(randomBytes(32).toString('base64url'), owner.client_request_id));
        await assert.rejects(service.lookup(owner.session_token, randomUUID()));
    });
    test('expiration, revocation and invalid CSRF fail closed', async () => {
        await assert.rejects(service.authorize(owner.session_token, 'invalid'), error => error.statusCode === 403);
        await service.authorize(owner.session_token, owner.csrf_token);
        clock = new Date(clock.getTime() + 31 * 86400000);
        await assert.rejects(service.open(owner.session_token), error => error.statusCode === 404);
    });
    test('request attachment rolls back with the order and preserves a recoverable empty intention', async () => {
        await assert.rejects(db.transaction(async trx => {
            const reserved = await service.lockCreation(trx, owner.session_token, owner.client_request_id, input);
            await service.attach(trx, reserved, 2147483647);
        }));
        assert.equal((await service.lookup(owner.session_token)).pedido_id, null);
    });
    test('revocation immediately blocks a previously valid browser secret', async () => {
        await db('checkout_sessoes').update({ revogado_em: clock });
        await assert.rejects(service.lookup(owner.session_token), error => error.statusCode === 404);
    });
    test('database rejects a current intention borrowed from another session', async () => {
        const other = await service.open();
        const record = await db('checkout_sessoes').where({ requisicao_atual: other.client_request_id }).first();
        const next = randomUUID();
        await db.transaction(async trx => {
            await trx('checkout_requisicoes').insert({ id: next, sessao_hash: record.token_hash });
            await trx('checkout_sessoes').where({ token_hash: record.token_hash }).update({ requisicao_atual: next });
        });
        await assert.rejects(db('checkout_sessoes').where({ requisicao_atual: owner.client_request_id }).update({ requisicao_atual: other.client_request_id }));
    });
});
