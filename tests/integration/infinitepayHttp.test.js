import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';

const digest = value => createHash('sha256').update(value).digest('hex');
describe('Fase 2D HTTP wiring with simulated providers only', { concurrency: false }, () => {
    let fixture, db, server, base, runtime, createRuntime, app, previousKey, method, size;
    let currentTime = new Date('2026-10-23T15:00:00Z'), checkoutCalls = 0, checkCalls = 0, proof, failCheck = false, failDelivery = false;
    const delivered = [], returns = new Map();
    before(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
        previousKey = process.env.INFINITEPAY_ENCRYPTION_KEY;
        process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
        [method] = await db('metodos_pagamento').insert({ nome: 'Método editável', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
        [size] = await db('tamanhos_marmitas').insert({ nome: 'Tamanho sintético', preco_base: 20 }).returning('*');
        const [credential] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-store', ...encryptApiKey('SYNTHETIC_2D_KEY', 'synthetic-store') }).returning('*');
        await db('config_infinitepay').where({ id: 1 }).update({ handle: 'synthetic-store', credencial_atual_id: credential.id });
        app = express(); app.use(express.json());
        app.use((req, res, next) => { req.auditBase = '/pagamentos'; next(); });
        try {
            ({ createInfinitepayRuntime: createRuntime } = await import('../../src/infinitepayRuntime.js'));
            const { default: routes } = await import('../../src/routes/Pagamentos.Routes.js');
            app.use('/pagamentos', routes);
        } catch (error) { assert.fail('Ligação HTTP financeira ausente: ' + error.code); }
        app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ status: 'fail', message: 'Falha segura' }));
        server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        base = 'http://127.0.0.1:' + server.address().port + '/pagamentos';
    });
    after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (fixture) await fixture.close();
        if (previousKey === undefined) delete process.env.INFINITEPAY_ENCRYPTION_KEY; else process.env.INFINITEPAY_ENCRYPTION_KEY = previousKey;
    });
    function install(options = {}) {
        runtime = createRuntime({ db, now: () => new Date(currentTime),
            checkoutClient: { async createCheckout({ apiKey, payload }) {
                assert.equal(apiKey, 'SYNTHETIC_2D_KEY'); checkoutCalls++; returns.set(payload.order_nsu, new URL(payload.redirect_url));
                if (options.uncertain) throw new Error('SYNTHETIC_2D_KEY provider secret');
                return { checkoutUrl: 'https://checkout.invalid.test/pay', invoiceSlug: 'slug-' + payload.order_nsu };
            } },
            checkClient: { async checkPayment() { checkCalls++; if (failCheck) throw new Error('SYNTHETIC_2D_KEY'); return proof || { paid: false }; } },
            parseEvent: raw => ({ type: raw.type, orderNsu: raw.order_nsu, transactionNsu: raw.transaction_nsu, invoiceSlug: raw.slug }),
            redirectUrl: 'https://backend.invalid.test/pagamentos/infinitepay/retorno', webhookUrl: 'https://backend.invalid.test/pagamentos/infinitepay/webhook',
            successUrl: 'https://shop.invalid.test/pedido/sucesso',
            deliver: async event => { if (failDelivery) throw new Error('SYNTHETIC_2D_KEY'); delivered.push(event); }, ...options });
        app.locals.infinitepayRuntime = runtime;
        return runtime;
    }
    async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
        return fetch(base + path, { method, redirect: 'manual', headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers
        }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    }
    async function order() {
        const [row] = await db('pedidos').insert({ nome_cliente: 'Cliente privado', telefone_cliente: '11999999999',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: 20, fluxo_pagamento: 'INFINITEPAY' }).returning('*');
        await db('itens_pedido').insert({ pedido_id: row.id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: 20, subtotal: 20 });
        const access = await db.transaction(trx => runtime.issueAccess(trx, row.id));
        return { row, access, uuid: randomUUID() };
    }
    async function begin(f) { return request('/retomar', { method: 'POST', token: f.access.access_token, body: { client_request_id: f.uuid } }); }
    async function event(f, type = 'paid', extra = {}) {
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        return request('/infinitepay/webhook', { method: 'POST', body: { type, order_nsu: payment.order_nsu, transaction_nsu: 'txn-' + payment.order_nsu, slug: payment.invoice_slug, ...extra } });
    }
    test('default application has no operational financial routes or transports enabled', async () => {
        for (const [path, method] of [['/consulta?ref=private', 'GET'], ['/retomar', 'POST'], ['/infinitepay/webhook', 'POST'], ['/infinitepay/retorno?r=private', 'GET']]) {
            const response = await request(path, { method }); assert.equal(response.status, 503);
            assert.equal(response.headers.get('cache-control'), 'no-store');
        }
        install(); assert.equal(await runtime.checkoutEnabled(db), false);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
    });
    test('tokens are random scoped expiring hashes; status exposes no personal or provider data', async () => {
        const f = await order();
        assert.notEqual(f.access.access_token, f.access.status_ref);
        assert.match(f.access.access_token, /^[A-Za-z0-9_-]{43}$/);
        const persisted = await db('pedido_acessos').where({ pedido_id: f.row.id });
        assert.equal(persisted.length, 2); assert.equal(persisted.some(row => row.token_hash === digest(f.access.access_token) && row.escopo === 'TITULAR'), true);
        const response = await request('/consulta?ref=' + f.access.status_ref); assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.data, { pagamento_status: 'SEM_TENTATIVA', cozinha_liberada: false });
        for (const secret of ['Cliente privado', '11999999999', 'SYNTHETIC_2D_KEY', 'checkout_url', 'receipt_url', 'token_hash']) assert.equal(JSON.stringify(body).includes(secret), false);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    });
    test('unknown, sequential, expired and revoked references cannot enumerate orders', async () => {
        const f = await order();
        for (const ref of ['1', '11999999999', randomBytes(32).toString('base64url'), '   ']) assert.equal((await request('/consulta?ref=' + encodeURIComponent(ref))).status, 404);
        await db('pedido_acessos').where({ token_hash: digest(f.access.status_ref) }).update({ revogado_em: currentTime });
        assert.equal((await request('/consulta?ref=' + f.access.status_ref)).status, 404);
        const old = await order();
        currentTime = new Date(currentTime.getTime() + 31 * 86400000);
        assert.equal((await request('/consulta?ref=' + old.access.status_ref)).status, 404);
        currentTime = new Date('2026-10-23T15:00:00Z');
    });
    test('STATUS cannot start or recover checkout and cookie/phone/ID never authorize', async () => {
        const f = await order();
        assert.equal((await request('/retomar', { method: 'POST', token: f.access.status_ref, body: { client_request_id: f.uuid } })).status, 404);
        assert.equal((await request('/retomar', { method: 'POST', body: { pedido_id: f.row.id, telefone: '11999999999', client_request_id: f.uuid } })).status, 404);
        assert.equal((await begin(f)).status, 503);
        assert.equal(await db('pagamentos').where({ pedido_id: f.row.id }).first(), undefined);
    });
    test('JSON-only authenticated initiation is concurrent and idempotent with one provider call', async () => {
        install({ creationEnabled: async () => true });
        const f = await order(), before = checkoutCalls;
        assert.equal((await request('/retomar', { method: 'POST', token: f.access.access_token, body: { client_request_id: f.uuid }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
        const responses = await Promise.all(Array.from({ length: 6 }, () => begin(f)));
        for (const response of responses) assert.equal(response.status, 200);
        assert.equal(checkoutCalls - before, 1);
        assert.equal(Number((await db('pagamentos').where({ pedido_id: f.row.id }).count('* as n').first()).n), 1);
        const retried = await begin(f); assert.equal((await retried.json()).data.checkout_url, 'https://checkout.invalid.test/pay');
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        assert.equal(delivered.length, 0);
    });
    test('invalid UUID, extra fields, other idempotency key and credentials from caller are rejected', async () => {
        const f = await order();
        for (const body of [{}, { client_request_id: ' ' }, { client_request_id: f.uuid, api_key: 'injected' }, { client_request_id: f.uuid, pedido_id: 2 }]) {
            assert.equal((await request('/retomar', { method: 'POST', token: f.access.access_token, body })).status, 400);
        }
        await begin(f);
        assert.equal((await request('/retomar', { method: 'POST', token: f.access.access_token, body: { client_request_id: randomUUID() } })).status, 409);
    });
    test('INCERTA never triggers another provider call on recovery even when creation is disabled', async () => {
        install({ creationEnabled: async () => true, uncertain: true });
        const f = await order(), before = checkoutCalls;
        assert.equal((await (await begin(f)).json()).data.pagamento_status, 'INCERTA');
        install();
        for (let i = 0; i < 3; i++) assert.equal((await (await begin(f)).json()).data.pagamento_status, 'INCERTA');
        assert.equal(checkoutCalls - before, 1);
    });
    test('invalid events are rejected, duplicate delivery is durable and acknowledgement never proves payment', async () => {
        install({ creationEnabled: async () => true }); proof = { paid: false };
        const f = await order(); await begin(f);
        const countBefore = Number((await db('pagamentos_eventos').count('* as n').first()).n);
        const checksBefore = checkCalls;
        for (const body of [{ type: 'invented' }, { type: 'paid', order_nsu: ' ' }, { type: 'paid', transaction_nsu: null, slug: '' }]) assert.equal((await request('/infinitepay/webhook', { method: 'POST', body })).status, 400);
        assert.equal((await request('/infinitepay/webhook', { method: 'POST', body: { type: 'paid' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
        const malformed = await fetch(base + '/infinitepay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":' });
        assert.equal(malformed.status, 400);
        assert.equal(Number((await db('pagamentos_eventos').count('* as n').first()).n), countBefore);
        const first = await event(f), second = await event(f);
        assert.equal(first.status, 200); assert.deepEqual(await first.json(), { status: 'accepted' }); assert.equal(second.status, 200);
        assert.equal(checkCalls, checksBefore);
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        assert.equal(Number((await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu' = ?", [payment.order_nsu]).count('* as n').first()).n), 1);
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        await runtime.processPending({ limit: 30 });
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
    });
    test('webhook acknowledges only after the database releases and commits the event insert', async () => {
        install({ creationEnabled: async () => true }); proof = { paid: false };
        const f = await order(); await begin(f);
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        const blocker = await db.transaction();
        let responsePromise, responded = false;
        const checksBefore = checkCalls;
        try {
            await blocker.raw('LOCK TABLE pagamentos_eventos IN SHARE MODE');
            const pid = (await blocker.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            responsePromise = event(f).then(response => { responded = true; return response; });
            const { setTimeout: pause } = await import('node:timers/promises');
            const deadline = Date.now() + 5000;
            let waiting = false;
            while (Date.now() < deadline) {
                waiting = (await db.raw('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
                if (waiting) break;
                await pause(10);
            }
            assert.equal(waiting, true, 'the real insert must reach the PostgreSQL lock');
            assert.equal(responded, false, 'no acknowledgement before durable persistence');
            assert.equal(await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu' = ?", [payment.order_nsu]).first(), undefined);
            await blocker.commit();
            const response = await responsePromise;
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { status: 'accepted' });
            const saved = await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu' = ?", [payment.order_nsu]).first();
            assert.equal(saved.status_processamento, 'PENDENTE');
            assert.equal(saved.tentativas, 0);
            assert.equal(checkCalls, checksBefore);
            assert.equal((await db('pagamentos').where({ id: payment.id }).first()).status, 'AGUARDANDO');
            assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        } finally {
            if (!blocker.isCompleted()) await blocker.rollback();
            if (responsePromise) await responsePromise;
        }
    });
    test('a real persistence failure is not acknowledged and a later delivery remains recoverable', async () => {
        install({ creationEnabled: async () => true });
        const f = await order(); await begin(f);
        const before = await db('pagamentos_eventos').select('*');
        const paymentBefore = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        const checksBefore = checkCalls;
        let response;
        // This fixture owns a random schema in the guarded disposable PostgreSQL only.
        await db.schema.renameTable('pagamentos_eventos', 'pagamentos_eventos_ack_failure');
        try { response = await event(f); }
        finally { await db.schema.renameTable('pagamentos_eventos_ack_failure', 'pagamentos_eventos'); }
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.notEqual(body.status, 'accepted');
        for (const secret of ['SYNTHETIC_2D_KEY', 'pagamentos_eventos_ack_failure', 'EVENT_STORAGE_FAILED']) assert.equal(JSON.stringify(body).includes(secret), false);
        assert.deepEqual(await db('pagamentos_eventos').select('*'), before);
        assert.deepEqual(await db('pagamentos').where({ id: paymentBefore.id }).first(), paymentBefore);
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        const retried = await event(f);
        assert.equal(retried.status, 200);
        assert.equal(Number((await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu' = ?", [paymentBefore.order_nsu]).count('* as n').first()).n), 1);
        assert.equal(checkCalls, checksBefore);
    });
    test('a valid event awaiting identification is durably acknowledged but remains pending', async () => {
        install({ creationEnabled: async () => true });
        const checksBefore = checkCalls;
        const body = { type: 'created' };
        assert.equal((await request('/infinitepay/webhook', { method: 'POST', body })).status, 200);
        const saved = await db('pagamentos_eventos').where({ tipo_evento: 'created', status_processamento: 'PENDENTE_IDENTIFICACAO' }).orderBy('id', 'desc').first();
        assert.ok(saved);
        assert.equal(saved.pagamento_id, null);
        assert.equal(saved.tentativas, 0);
        assert.equal(checkCalls, checksBefore);
    });
    test('valid nonce correlates browser return, grants STATUS only and strips provider data in 303', async () => {
        const f = await order(); await begin(f);
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        const nonce = returns.get(payment.order_nsu).searchParams.get('r');
        const before = checkCalls;
        const path = '/infinitepay/retorno?r=' + nonce + '&order_nsu=' + payment.order_nsu + '&transaction_nsu=txn-' + payment.order_nsu + '&slug=' + payment.invoice_slug + '&paid=true&receipt_url=https://evil.invalid';
        const response = await request(path); assert.equal(response.status, 303); assert.equal(checkCalls, before);
        const target = new URL(response.headers.get('location')); assert.equal(target.origin, 'https://shop.invalid.test');
        assert.deepEqual([...target.searchParams.keys()], ['ref']);
        const ref = target.searchParams.get('ref'); assert.match(ref, /^[A-Za-z0-9_-]{43}$/);
        assert.equal((await request('/retomar', { method: 'POST', token: ref, body: { client_request_id: f.uuid } })).status, 404);
        assert.equal((await (await request('/consulta?ref=' + ref)).json()).data.cozinha_liberada, false);
        for (const query of ['r=' + nonce + '&order_nsu=other', 'r=invalid', 'r=' + nonce + '&r=' + nonce]) assert.equal((await request('/infinitepay/retorno?' + query)).status, 400);
    });
    test('return with missing verification identifiers is durably pending and never authorizes payment', async () => {
        const f = await order(); await begin(f);
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        const nonce = returns.get(payment.order_nsu).searchParams.get('r');
        const response = await request('/infinitepay/retorno?r=' + nonce + '&order_nsu=' + payment.order_nsu);
        assert.equal(response.status, 303);
        await runtime.processPending({ limit: 30 });
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        const pending = await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu' = ?", [payment.order_nsu]).first();
        assert.ok(pending); assert.notEqual(pending.status_processamento, 'CONCLUIDO');
    });
    test('expired links cannot be resumed and do not create another attempt', async () => {
        const f = await order(); await begin(f); const before = checkoutCalls;
        const payment = await db('pagamentos').where({ pedido_id: f.row.id }).first();
        await db('pagamentos').where({ id: payment.id }).update({ valid_until: new Date(currentTime.getTime() - 1) });
        const response = await begin(f); assert.equal(response.status, 200); assert.equal((await response.json()).data.checkout_url, undefined);
        assert.equal(checkoutCalls, before);
        const nonce = returns.get(payment.order_nsu).searchParams.get('r');
        await db('pagamentos').where({ id: payment.id }).update({ valid_until: new Date(currentTime.getTime() - 2 * 86400000) });
        assert.equal((await request('/infinitepay/retorno?r=' + nonce + '&order_nsu=' + payment.order_nsu)).status, 400);
    });
    test('production cannot use the test-only creation gate override', async () => {
        const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
        try { assert.throws(() => install({ creationEnabled: async () => true }), /Gate/); }
        finally { process.env.NODE_ENV = previous; }
    });
    test('query failure preserves pending reconciliation and cannot leak credentials or release kitchen', async () => {
        const f = await order(); await begin(f); await event(f); failCheck = true;
        try { await runtime.processPending({ limit: 30 }); } finally { failCheck = false; }
        assert.equal((await db('pedidos').where({ id: f.row.id }).first()).liberado_cozinha_em, null);
        const events = await db('pagamentos_eventos').select('*'); assert.equal(JSON.stringify(events).includes('SYNTHETIC_2D_KEY'), false);
        assert.equal(events.some(row => ['PENDENTE', 'ERRO', 'PENDENTE_IDENTIFICACAO'].includes(row.status_processamento)), true);
    });
    test('independently verified payment without buyer return releases once and outbox recovers after delivery failure', async () => {
        currentTime = new Date(currentTime.getTime() + 60000);
        const f = await order(); await begin(f); await event(f); await event(f, 'created');
        proof = { paid: true, amount: 2000, paidAmount: 2010, installments: 1, captureMethod: 'pix' }; failDelivery = true;
        await runtime.processPending({ limit: 100 }); failDelivery = false;
        const saved = await db('pedidos').where({ id: f.row.id }).first(); assert.ok(saved.liberado_cozinha_em);
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: f.row.id, tipo: 'PEDIDO_LIBERADO' }).count('* as n').first()).n), 1);
        assert.equal(delivered.filter(row => row.pedidoId === f.row.id).length, 0);
        currentTime = new Date(currentTime.getTime() + 60000); await runtime.processPending({ limit: 100 });
        assert.equal(delivered.filter(row => row.pedidoId === f.row.id).length, 1);
        await event(f, 'created', { changed_delivery: true }); proof = { paid: false }; await runtime.processPending({ limit: 100 });
        assert.equal((await db('pagamentos').where({ pedido_id: f.row.id }).first()).status, 'PAGA');
        assert.equal(delivered.filter(row => row.pedidoId === f.row.id).length, 1);
        const status = await (await request('/consulta?ref=' + f.access.status_ref)).json(); assert.equal(status.data.cozinha_liberada, true); assert.equal(status.data.pagamento_status, 'PAGA');
    });
});
