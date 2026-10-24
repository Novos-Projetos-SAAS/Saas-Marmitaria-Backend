import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';

describe('recoverable internal payment outbox', { concurrency: false }, () => {
    let fixture, db, method, clock;
    before(async () => {
        fixture = await createTestDatabase();
        db = fixture.db;
        await db.migrate.latest();
        [method] = await db('metodos_pagamento').insert({ nome: 'PIX sintético outbox', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
    });
    beforeEach(async () => {
        await db('outbox_eventos').del();
        await db('pagamentos').del();
        await db('pedidos').del();
        clock = new Date('2026-10-23T12:00:00Z');
    });
    after(async () => { if (fixture) await fixture.close(); });

    async function service(deliver, options = {}) {
        let module;
        try { module = await import('../../src/services/paymentOutboxService.js'); }
        catch (error) { assert.fail('Entrega recuperável da outbox ausente: ' + error.code); }
        return module.createPaymentOutboxService({ db, deliver, now: () => new Date(clock), leaseMs: 1000, retryMs: 100, ...options });
    }
    async function release({ order = {}, payment = {}, event = {} } = {}) {
        const [pedido] = await db('pedidos').insert({ nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id,
            status: 'Pendente', valor_total: '20.10', fluxo_pagamento: 'INFINITEPAY', liberado_cozinha_em: clock, ...order }).returning('*');
        await db('pagamentos').insert({ pedido_id: pedido.id, tentativa_numero: 1, order_nsu: randomUUID(), status: 'PAGA',
            valor_centavos: 2010, valor_base_provider_centavos: 2010, valid_until: clock,
            provider_verified_at: clock, pago_em: clock, transaction_nsu: 'synthetic-transaction-' + pedido.id,
            invoice_slug: 'synthetic-invoice-' + pedido.id, capture_method: 'pix', ...payment });
        const [row] = await db('outbox_eventos').insert({ pedido_id: pedido.id, tipo: 'PEDIDO_LIBERADO',
            chave_unica: 'pedido_liberado:' + pedido.id, ...event }).returning('*');
        return { pedido, row };
    }
    function gate() {
        let open;
        const promise = new Promise(resolve => { open = resolve; });
        return { promise, open };
    }
    async function databaseFailure(targetStatus) {
        await db.raw(`CREATE FUNCTION reject_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'SYNTHETIC_OUTBOX_SECRET rawbody private@example.invalid'; END $$`);
        await db.raw(`CREATE TRIGGER reject_outbox_update BEFORE UPDATE ON outbox_eventos FOR EACH ROW
            WHEN (NEW.status = '${targetStatus}') EXECUTE FUNCTION reject_outbox_update()`);
    }
    async function removeDatabaseFailure() {
        await db.raw('DROP TRIGGER reject_outbox_update ON outbox_eventos');
        await db.raw('DROP FUNCTION reject_outbox_update()');
    }
    function sanitizedFailure(error) {
        assert.equal(error.code, 'OUTBOX_PROCESSING_FAILED');
        assert.equal(error.message, 'Não foi possível processar a entrega financeira.');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.equal(/SYNTHETIC_OUTBOX_SECRET|rawbody|private@example.invalid/.test(JSON.stringify(error, Object.getOwnPropertyNames(error))), false);
        return true;
    }

    test('requires an explicit delivery adapter', async () => {
        await assert.rejects(service(undefined), /deliver/i);
    });

    test('delivers only the minimal DTO, commits the lease before delivery and acknowledges once', async () => {
        const { pedido, row } = await release({ event: { payload_reduzido: { receipt_url: 'https://secret.invalid',
            nome_cliente: 'PRIVATE', nested: { apiKey: 'PRIVATE' }, pedidoId: 999, key: 'attacker' } } });
        let received;
        const worker = await service(async dto => {
            received = dto;
            await db.transaction(async trx => {
                const claimed = await trx('outbox_eventos').where({ id: row.id }).forUpdate().noWait().first();
                assert.equal(claimed.status, 'PROCESSANDO');
                assert.equal(claimed.tentativas, 1);
                assert.match(claimed.locked_by, /^[a-f0-9-]{36}$/);
                await trx('pedidos').where({ id: pedido.id }).forUpdate().noWait().first();
            });
        });
        assert.deepEqual(await worker.processNext(), { id: row.id, pedidoId: pedido.id, tipo: 'PEDIDO_LIBERADO', key: 'pedido_liberado:' + pedido.id });
        assert.deepEqual(Object.keys(received).sort(), ['id', 'key', 'pedidoId', 'tipo']);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'CONCLUIDO');
        assert.equal(saved.locked_by, null);
        assert.equal(saved.locked_until, null);
        assert.equal(saved.processado_em.toISOString(), clock.toISOString());
        assert.equal(await worker.processNext(), null);
    });

    test('two factories deliver once while the first lease is active', { timeout: 10000 }, async () => {
        await release();
        const entered = gate(), finish = gate();
        let calls = 0;
        const first = await service(async () => { calls++; entered.open(); await finish.promise; });
        const second = await service(async () => { calls++; });
        const pending = first.processNext();
        try {
            await Promise.race([entered.promise, pending.then(() => assert.fail('delivery did not start'))]);
            assert.equal(await second.processNext(), null);
            assert.equal(calls, 1);
        } finally { finish.open(); await pending; }
    });

    test('SKIP LOCKED allows a second due event to proceed while another row is locked', async () => {
        const first = await release(), second = await release();
        const trx = await db.transaction();
        try {
            await trx('outbox_eventos').where({ id: first.row.id }).forUpdate().first();
            const worker = await service(async () => {});
            assert.equal((await worker.processNext()).id, second.row.id);
        } finally { await trx.rollback(); }
    });

    test('fresh factories recover PENDENTE and due ERRO with backoff and the same consumer key', async () => {
        const { row } = await release();
        const failure = await service(async () => { throw new Error('synthetic adapter failure'); });
        await assert.rejects(failure.processNext(), sanitizedFailure);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'ERRO');
        assert.equal(saved.tentativas, 1);
        assert.equal(saved.proxima_tentativa_em.toISOString(), '2026-10-23T12:00:00.100Z');
        let calls = 0;
        const restarted = await service(async () => { calls++; });
        assert.equal(await restarted.processNext(), null);
        clock = new Date('2026-10-23T12:00:00.100Z');
        assert.equal((await restarted.processNext()).key, row.chave_unica);
        assert.equal(calls, 1);
        assert.equal((await db('outbox_eventos').where({ id: row.id }).first()).tentativas, 2);
    });

    for (const staleFails of [false, true]) test('expired lease is recovered and stale ' + (staleFails ? 'failure' : 'ack') + ' cannot overwrite the new worker', { timeout: 10000 }, async () => {
        const { row } = await release();
        const entered = gate(), finish = gate();
        let firstToken;
        const old = await service(async () => {
            firstToken = (await db('outbox_eventos').where({ id: row.id }).first()).locked_by;
            entered.open(); await finish.promise;
            if (staleFails) throw new Error('stale adapter failure');
        });
        const pending = old.processNext();
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        try {
            await Promise.race([entered.promise, outcome.then(() => assert.fail('delivery did not start'))]);
            clock = new Date('2026-10-23T12:00:01.001Z');
            const fresh = await service(async () => {
                const current = await db('outbox_eventos').where({ id: row.id }).first();
                assert.notEqual(current.locked_by, firstToken);
                assert.equal(current.tentativas, 2);
            });
            assert.equal((await fresh.processNext()).id, row.id);
        } finally { finish.open(); await outcome; }
        const result = await outcome;
        if (staleFails) sanitizedFailure(result.error);
        else assert.equal(result.value, null);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'CONCLUIDO');
        assert.equal(saved.tentativas, 2);
        assert.equal(saved.locked_by, null);
    });

    test('database failure before delivery rolls back the claim and can be retried after restart', async () => {
        const { row } = await release();
        let calls = 0;
        await databaseFailure('PROCESSANDO');
        try {
            const worker = await service(async () => { calls++; });
            await assert.rejects(worker.processNext(), sanitizedFailure);
            assert.equal(calls, 0);
            assert.equal((await db('outbox_eventos').where({ id: row.id }).first()).status, 'PENDENTE');
        } finally { await removeDatabaseFailure(); }
        const restarted = await service(async () => { calls++; });
        assert.equal((await restarted.processNext()).id, row.id);
        assert.equal(calls, 1);
    });

    test('database failure after delivery preserves the lease for at-least-once recovery with a stable key', async () => {
        const { row } = await release();
        const delivered = [];
        await databaseFailure('CONCLUIDO');
        try {
            const worker = await service(async dto => { delivered.push(dto); });
            await assert.rejects(worker.processNext(), sanitizedFailure);
            const saved = await db('outbox_eventos').where({ id: row.id }).first();
            assert.equal(saved.status, 'PROCESSANDO');
            assert.notEqual(saved.locked_by, null);
            assert.equal(saved.processado_em, null);
        } finally { await removeDatabaseFailure(); }
        const restarted = await service(async dto => { delivered.push(dto); });
        assert.equal(await restarted.processNext(), null);
        clock = new Date('2026-10-23T12:00:01.001Z');
        assert.equal((await restarted.processNext()).id, row.id);
        assert.deepEqual(delivered[0], delivered[1]);
        assert.equal(delivered.length, 2);
        assert.equal(await db('outbox_eventos').count('* as n').first().then(r => Number(r.n)), 1);
    });

    for (const [name, overrides] of [
        ['unpaid', { payment: { status: 'AGUARDANDO', provider_verified_at: null, pago_em: null } }],
        ['POSTERIOR', { order: { fluxo_pagamento: 'POSTERIOR' } }],
        ['missing release', { order: { liberado_cozinha_em: null } }],
        ['missing verification', { payment: { provider_verified_at: null } }],
        ['amount mismatch', { payment: { valor_base_provider_centavos: 2000 } }],
        ['order amount mismatch', { order: { valor_total: '20.00' } }],
        ['blank identity', { payment: { transaction_nsu: ' \t ' } }],
        ['missing invoice', { payment: { invoice_slug: null } }],
        ['unsupported capture', { payment: { capture_method: 'cash' } }],
    ]) test('never delivers an operationally ineligible ' + name + ' order', async () => {
        const { pedido } = await release(overrides);
        const before = await db('pedidos').where({ id: pedido.id }).first();
        let calls = 0;
        const worker = await service(async () => { calls++; });
        assert.equal(await worker.processNext(), null);
        assert.equal(calls, 0);
        assert.deepEqual(await db('pedidos').where({ id: pedido.id }).first(), before);
    });

    test('a previously confirmed and released ESTORNADA order remains operationally eligible', async () => {
        const { row } = await release({ payment: { status: 'ESTORNADA', estornado_em: clock } });
        const worker = await service(async () => {});
        assert.equal((await worker.processNext()).id, row.id);
    });

    test('only PEDIDO_LIBERADO is dispatched and scheduled work waits until due', async () => {
        await release({ event: { tipo: 'PAGAMENTO_ATUALIZADO' } });
        const { row } = await release({ event: { proxima_tentativa_em: new Date('2026-10-23T12:01:00Z') } });
        const worker = await service(async () => {});
        assert.equal(await worker.processNext(), null);
        clock = new Date('2026-10-23T12:01:00Z');
        assert.equal((await worker.processNext()).id, row.id);
        assert.equal((await db('outbox_eventos').where({ tipo: 'PAGAMENTO_ATUALIZADO' }).first()).status, 'PENDENTE');
    });

    test('attempt limit bounds repeated delivery failures and remains effective after restart', async () => {
        const { row } = await release();
        let calls = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            const worker = await service(async () => { calls++; throw new Error('delivery unavailable'); }, { maxAttempts: 2 });
            await assert.rejects(worker.processNext(), sanitizedFailure);
            clock = new Date(clock.getTime() + 1000);
        }
        const restarted = await service(async () => { calls++; }, { maxAttempts: 2 });
        assert.equal(await restarted.processNext(), null);
        assert.equal(calls, 2);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'ERRO');
        assert.equal(saved.tentativas, 2);
    });

    test('delivery errors expose only a static code and message without raw body or cause', async () => {
        const { row } = await release();
        const worker = await service(async () => {
            const error = new Error('SYNTHETIC_OUTBOX_SECRET rawbody private@example.invalid');
            error.response = { rawbody: 'SYNTHETIC_OUTBOX_SECRET' };
            throw error;
        });
        await assert.rejects(worker.processNext(), sanitizedFailure);
        assert.equal((await db('outbox_eventos').where({ id: row.id }).first()).status, 'ERRO');
    });

    test('eligibility database errors are sanitized while the committed lease stays recoverable', async () => {
        const { row } = await release();
        // Falha apenas a leitura de elegibilidade; o claim continua usando PostgreSQL real.
        const failingDb = Object.assign(table => {
            if (table === 'pedidos') throw new Error('SYNTHETIC_OUTBOX_SECRET rawbody private@example.invalid');
            return db(table);
        }, { transaction: callback => db.transaction(callback) });
        let calls = 0;
        const worker = await service(async () => { calls++; }, { db: failingDb });
        await assert.rejects(worker.processNext(), sanitizedFailure);
        assert.equal(calls, 0);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'PROCESSANDO');
        assert.notEqual(saved.locked_by, null);
    });

    test('an expired last-attempt lease becomes unlocked ERRO after ack failure without redelivery', async () => {
        const { row } = await release();
        let calls = 0;
        await databaseFailure('CONCLUIDO');
        try {
            const worker = await service(async () => { calls++; }, { maxAttempts: 1 });
            await assert.rejects(worker.processNext(), sanitizedFailure);
        } finally { await removeDatabaseFailure(); }
        const restarted = await service(async () => { calls++; }, { maxAttempts: 1 });
        assert.equal(await restarted.processNext(), null);
        assert.equal((await db('outbox_eventos').where({ id: row.id }).first()).status, 'PROCESSANDO');
        clock = new Date('2026-10-23T12:00:01.001Z');
        assert.equal(await restarted.processNext(), null);
        const saved = await db('outbox_eventos').where({ id: row.id }).first();
        assert.equal(saved.status, 'ERRO');
        assert.equal(saved.locked_by, null);
        assert.equal(saved.locked_until, null);
        assert.equal(saved.proxima_tentativa_em, null);
        assert.equal(saved.tentativas, 1);
        assert.equal(saved.processado_em, null);
        assert.equal(await restarted.processNext(), null);
        assert.equal(calls, 1);
    });
});
