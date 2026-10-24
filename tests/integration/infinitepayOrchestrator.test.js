import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { aplicarElegibilidadeOperacional } from '../../src/utils/pedidoPaymentPolicy.js';
import { createInfinitepayClient } from '../../src/services/infinitepayClient.js';

let fixture, db, method, size, food, credential;
const clock = new Date('2026-10-22T15:00:00Z');
const syntheticKey = 'SYNTHETIC_ORCHESTRATOR_KEY_NEVER_LOG';
const redirectUrl = 'https://backend.invalid.test/pagamentos/infinitepay/retorno';
const webhookUrl = 'https://backend.invalid.test/pagamentos/infinitepay/webhook';
const checkoutUrl = 'https://checkout.invalid.test/pay/synthetic';

describe('internal checkout reservation', { concurrency: false }, () => {
    let previousEncryptionKey;
    before(async () => {
        fixture = await createTestDatabase();
        db = fixture.db;
        await db.migrate.latest();
        previousEncryptionKey = process.env.INFINITEPAY_ENCRYPTION_KEY;
        process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
        process.env.INFINITEPAY_CHECKOUT_ENABLED = 'false';
        [method] = await db('metodos_pagamento').insert({ nome: 'Nome editável sintético', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
        [size] = await db('tamanhos_marmitas').insert({ nome: 'Tamanho sintético', preco_base: '99.99' }).returning('*');
        const [category] = await db('categorias_alimentos').insert({ nome: 'Categoria sintética', limite_escolhas: 1 }).returning('*');
        [food] = await db('alimentos').insert({ nome: 'Arroz sintético', categoria_id: category.id, disponivel_hoje: true }).returning('*');
        [credential] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-store', ...encryptApiKey(syntheticKey, 'synthetic-store') }).returning('*');
        await db('config_infinitepay').where({ id: 1 }).update({ handle: 'synthetic-store', credencial_atual_id: credential.id, assured_installments: 1 });
    });
    after(async () => {
        try { if (fixture) await fixture.close(); }
        finally {
            if (previousEncryptionKey === undefined) delete process.env.INFINITEPAY_ENCRYPTION_KEY;
            else process.env.INFINITEPAY_ENCRYPTION_KEY = previousEncryptionKey;
        }
    });

    async function orderFixture(overrides = {}) {
        const [order] = await db('pedidos').insert({ nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id,
            status: 'Pendente', valor_total: '20.10', fluxo_pagamento: 'INFINITEPAY', ...overrides }).returning('*');
        const [item] = await db('itens_pedido').insert({ pedido_id: order.id, tamanho_marmita_id: size.id,
            quantidade: 2, preco_unitario: '10.05', subtotal: '20.10' }).returning('*');
        await db('composicao_item_pedido').insert({ item_pedido_id: item.id, alimento_id: food.id });
        return order;
    }
    async function orchestrator(client = { async createCheckout() { return { checkoutUrl }; } }, options = {}) {
        let module;
        try { module = await import('../../src/services/paymentOrchestrator.js'); }
        catch (error) { assert.fail('Reserva financeira interna ainda ausente: ' + error.code); }
        return module.createPaymentOrchestrator({ db, client, redirectUrl, webhookUrl, now: () => new Date(clock), ...options });
    }

    test('reservation commits trusted snapshots and credential identity before simulated transport without holding the order lock', async () => {
        const order = await orderFixture();
        const requestId = randomUUID();
        let observed;
        const client = { async createCheckout(input) {
            observed = input;
            const reserved = await db('pagamentos').where({ pedido_id: order.id }).first();
            assert.equal(reserved.status, 'CRIANDO');
            assert.equal(reserved.credencial_id, credential.id);
            assert.equal(reserved.handle_snapshot, 'synthetic-store');
            assert.equal(reserved.valor_centavos, '2010');
            assert.match(reserved.return_nonce_hash, /^[a-f0-9]{64}$/);
            await db.transaction(async trx => { await trx('pedidos').where({ id: order.id }).forUpdate().noWait().first(); });
            return { checkoutUrl, invoiceSlug: 'synthetic-invoice' };
        } };
        const service = await orchestrator(client);
        const result = await service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId });
        assert.equal(result.status, 'AGUARDANDO');
        assert.equal(result.checkoutUrl, checkoutUrl);
        assert.equal(observed.apiKey, syntheticKey);
        assert.deepEqual(observed.payload.items, [{ quantity: 1, price: 2010, description: 'Pedido #' + order.id + ' — Marmitas e complementos' }]);
        assert.equal(observed.payload.options.single_payment, true);
        assert.equal(observed.payload.options.require_delivery_address, false);
        assert.equal(observed.payload.options.discounts, undefined);
        assert.equal(observed.payload.options.valid_until, '2026-10-23T02:59:59.000Z');
        assert.equal(new URL(observed.payload.redirect_url).searchParams.get('r').length > 30, true);
        const saved = await db('pedidos').where({ id: order.id }).first();
        assert.equal(saved.client_request_id, requestId);
        assert.match(saved.client_payload_hash, /^[a-f0-9]{64}$/);
        assert.equal(saved.liberado_cozinha_em, null);
        assert.equal(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first(), undefined);
        assert.equal(JSON.stringify(result).includes(syntheticKey), false);
        assert.equal(JSON.stringify(result).includes(saved.telefone_cliente), false);
        assert.equal(await db('outbox_eventos').count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('concurrent clicks and repeated requests dispatch only once and return the same attempt', { timeout: 10000 }, async () => {
        const order = await orderFixture();
        const input = { pedidoId: order.id, clientRequestId: randomUUID() };
        let release, entered, calls = 0;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        const service = await orchestrator({ async createCheckout() { calls++; entered(); await gate; return { checkoutUrl }; } });
        const first = service.prepareCheckout(input);
        try {
            await Promise.race([started, first.then(() => assert.fail('Attempt completed before entering the simulated transport'))]);
            const duplicates = await Promise.all(Array.from({ length: 8 }, () => service.prepareCheckout(input)));
            assert.equal(calls, 1);
            assert.equal(duplicates.every(row => row.status === 'CRIANDO'), true);
            assert.equal(new Set(duplicates.map(row => row.attemptId)).size, 1);
            release();
            const completed = await first;
            const repeated = await service.prepareCheckout(input);
            assert.equal(repeated.attemptId, completed.attemptId);
            assert.equal(repeated.status, 'AGUARDANDO');
            assert.equal(calls, 1);
            assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 1);
        } finally { release(); await first; }
    });

    test('UUID binding is global across orders and a conflicting reservation rolls back without partial state', async () => {
        const first = await orderFixture();
        const second = await orderFixture();
        const requestId = randomUUID();
        const service = await orchestrator();
        const results = await Promise.allSettled([first, second].map(order => service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId })));
        assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
        const rejected = results.find(row => row.status === 'rejected');
        assert.equal(rejected.reason.code, 'IDEMPOTENCY_CONFLICT');
        const rows = await db('pedidos').whereIn('id', [first.id, second.id]).orderBy('id');
        assert.equal(rows.filter(row => row.client_request_id === requestId).length, 1);
        const loser = rows.find(row => row.client_request_id === null);
        assert.equal(loser.client_payload_hash, null);
        assert.equal(await db('pagamentos').where({ pedido_id: loser.id }).count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('a second UUID or changed trusted content cannot reuse a reservation to charge again', async () => {
        const order = await orderFixture();
        const requestId = randomUUID();
        let calls = 0;
        const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } });
        await service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId });
        await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }), error => error.code === 'IDEMPOTENCY_CONFLICT');
        await db('pedidos').where({ id: order.id }).update({ observacoes: 'Alteração sintética após reserva' });
        await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId }), error => error.code === 'IDEMPOTENCY_CONFLICT');
        assert.equal(calls, 1);
    });

    for (const [label, clientError] of [['network', new Error(syntheticKey + ' ECONNRESET')], ['timeout', Object.assign(new Error(syntheticKey), { name: 'AbortError' })]]) {
        test(label + ' failure preserves an uncertain payable attempt and never retries it', async () => {
            const order = await orderFixture();
            const input = { pedidoId: order.id, clientRequestId: randomUUID() };
            let calls = 0;
            const service = await orchestrator({ async createCheckout() { calls++; throw clientError; } });
            const result = await service.prepareCheckout(input);
            assert.equal(result.status, 'INCERTA');
            const saved = await db('pagamentos').where({ pedido_id: order.id }).first();
            assert.equal(saved.bloqueia_nova_cobranca, true);
            assert.equal(saved.error_code, 'CHECKOUT_RESULT_UNKNOWN');
            assert.equal(JSON.stringify(saved).includes(syntheticKey), false);
            assert.equal(JSON.stringify(result).includes(syntheticKey), false);
            assert.equal((await service.prepareCheckout(input)).attemptId, result.attemptId);
            assert.equal(calls, 1);
            assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
        });
    }

    test('a malformed simulated response remains uncertain instead of admitting an unsafe checkout URL', async () => {
        const order = await orderFixture();
        const service = await orchestrator({ async createCheckout() { return { checkoutUrl: 'javascript:alert(1)' }; } });
        assert.equal((await service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() })).status, 'INCERTA');
        assert.equal((await db('pagamentos').where({ pedido_id: order.id }).first()).checkout_url, null);
    });

    test('a local credential failure is recorded without sending and still does not permit an automatic second attempt', async () => {
        const order = await orderFixture();
        const input = { pedidoId: order.id, clientRequestId: randomUUID() };
        const previous = process.env.INFINITEPAY_ENCRYPTION_KEY;
        process.env.INFINITEPAY_ENCRYPTION_KEY = 'SYNTHETIC_INVALID_ENCRYPTION_KEY';
        let calls = 0;
        try {
            const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } });
            assert.equal((await service.prepareCheckout(input)).status, 'FALHOU');
            assert.equal((await service.prepareCheckout(input)).status, 'FALHOU');
            assert.equal(calls, 0);
            assert.equal((await db('pagamentos').where({ pedido_id: order.id }).first()).bloqueia_nova_cobranca, true);
        } finally { process.env.INFINITEPAY_ENCRYPTION_KEY = previous; }
    });

    test('late success cannot downgrade a state already advanced by another trusted writer', async () => {
        const order = await orderFixture();
        const service = await orchestrator({ async createCheckout() {
            await db('pagamentos').where({ pedido_id: order.id }).update({ status: 'PAGA' });
            return { checkoutUrl };
        } });
        const result = await service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() });
        assert.equal(result.status, 'PAGA');
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
    });

    for (const type of ['POSTERIOR', 'UNMAPPED', 'DEBITO', 'CARTAO_DEBITO', 'DINHEIRO']) {
        test('reservation refuses ' + type + ' without altering the legacy order or creating financial rows', async () => {
            let methodId = method.id;
            if (type !== 'POSTERIOR') {
                const [other] = await db('metodos_pagamento').insert({ nome: 'Pix editável sintético ' + type,
                    codigo: type === 'UNMAPPED' ? null : type,
                    tipo_financeiro: type === 'CARTAO_DEBITO' ? 'DEBITO' : type === 'UNMAPPED' ? 'OUTRO' : type }).returning('*');
                methodId = other.id;
            }
            const order = await orderFixture({ fluxo_pagamento: type === 'POSTERIOR' ? 'POSTERIOR' : 'INFINITEPAY', metodo_pagamento_id: methodId });
            let calls = 0;
            const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } });
            await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }),
                error => error.code === (type === 'POSTERIOR' ? 'POSTERIOR_ORDER' : 'PAYMENT_METHOD_NOT_MAPPED'));
            assert.deepEqual(await db('pedidos').where({ id: order.id }).first(), order);
            assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
            assert.equal(calls, 0);
        });
    }

    test('inconsistent item totals and invalid request IDs are rejected before reservation', async () => {
        const order = await orderFixture();
        const service = await orchestrator();
        for (const clientRequestId of [null, '', '   ', 'not-a-uuid']) {
            await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId }));
        }
        await db('itens_pedido').where({ pedido_id: order.id }).update({ subtotal: '19.99' });
        await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }));
        assert.equal((await db('pedidos').where({ id: order.id }).first()).client_request_id, null);
        assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('an already released order never receives a new financial attempt', async () => {
        const order = await orderFixture({ liberado_cozinha_em: new Date(clock) });
        const service = await orchestrator();
        await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }));
        assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('prepared client and reservation exchange only the documented payload through an injected transport', async () => {
        const order = await orderFixture({ telefone_cliente: '+5511999999999' });
        let calls = 0;
        const client = createInfinitepayClient({ now: () => new Date(clock), checkoutOrigins: ['https://checkout.invalid.test'],
            parseCreatedLink: data => ({ checkoutUrl: data.syntheticUrl, invoiceSlug: data.syntheticSlug }),
            async transport(url, request) {
                calls++;
                assert.equal(url, 'https://api.checkout.infinitepay.io/links');
                assert.equal(request.method, 'POST');
                assert.equal(request.redirect, 'error');
                assert.equal(request.headers['X-Api-Key'], syntheticKey);
                assert.equal(request.body.includes(syntheticKey), false);
                assert.equal(request.body.includes('synthetic-store'), false);
                const payload = JSON.parse(request.body);
                assert.deepEqual(payload.customer, { name: 'Cliente sintético', phone_number: '+5511999999999' });
                assert.equal(payload.items[0].price, 2010);
                assert.deepEqual(payload.options.payment_methods_enabled, ['pix', 'credit_card']);
                return { status: 201, async json() { return { syntheticUrl: checkoutUrl, syntheticSlug: 'synthetic-slug' }; } };
            } });
        const service = await orchestrator(client);
        const result = await service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() });
        assert.equal(calls, 1);
        assert.equal(result.status, 'AGUARDANDO');
        const saved = await db('pagamentos').where({ pedido_id: order.id }).first();
        assert.equal(saved.invoice_slug, 'synthetic-slug');
        assert.equal(saved.provider_verified_at, null);
        assert.equal(saved.pago_em, null);
        assert.equal(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first(), undefined);
    });

    for (const failure of ['deadline', 'http-status']) {
        test('prepared client ' + failure + ' persists INCERTA and a replay never dispatches again', async () => {
            const order = await orderFixture();
            const input = { pedidoId: order.id, clientRequestId: randomUUID() };
            let calls = 0;
            const client = createInfinitepayClient({ now: () => new Date(clock), timeoutMs: 15,
                checkoutOrigins: ['https://checkout.invalid.test'], parseCreatedLink: data => data,
                async transport() {
                    calls++;
                    if (failure === 'deadline') return new Promise(() => {});
                    return { status: 503, async json() { throw new Error(syntheticKey); } };
                } });
            const service = await orchestrator(client);
            assert.equal((await service.prepareCheckout(input)).status, 'INCERTA');
            assert.equal((await service.prepareCheckout(input)).status, 'INCERTA');
            assert.equal(calls, 1);
            const saved = await db('pagamentos').where({ pedido_id: order.id }).first();
            assert.equal(saved.bloqueia_nova_cobranca, true);
            assert.equal(saved.checkout_url, null);
            assert.equal(saved.transaction_nsu, null);
            assert.equal(saved.provider_verified_at, null);
            assert.equal(JSON.stringify(saved).includes(syntheticKey), false);
            assert.equal(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first(), undefined);
        });
    }

    test('a failed result commit leaves the durable CRIANDO reservation and cannot dispatch a second time', async () => {
        const order = await orderFixture();
        const input = { pedidoId: order.id, clientRequestId: randomUUID() };
        let transactions = 0, calls = 0;
        const failingDb = { async transaction(callback) {
            transactions++;
            if (transactions === 2) throw new Error(syntheticKey + ' synthetic database unavailable');
            return db.transaction(callback);
        } };
        const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } }, { db: failingDb });
        await assert.rejects(service.prepareCheckout(input), error => error.code === 'CHECKOUT_PERSISTENCE_UNCERTAIN' &&
            error.statusCode === 503 && !JSON.stringify(error).includes(syntheticKey));
        const saved = await db('pagamentos').where({ pedido_id: order.id }).first();
        assert.equal(saved.status, 'CRIANDO');
        assert.equal(saved.bloqueia_nova_cobranca, true);
        assert.equal((await service.prepareCheckout(input)).attemptId, saved.id);
        await assert.rejects(service.prepareCheckout({ ...input, clientRequestId: randomUUID() }), error => error.code === 'IDEMPOTENCY_CONFLICT');
        assert.equal(calls, 1);
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
    });

    test('rotation after reservation preserves the credential snapshot and never redispatches a replay', async () => {
        const order = await orderFixture();
        const input = { pedidoId: order.id, clientRequestId: randomUUID() };
        let calls = 0;
        const [rotated] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-store',
            ...encryptApiKey('SYNTHETIC_ROTATED_KEY', 'synthetic-store') }).returning('*');
        const service = await orchestrator({ async createCheckout({ apiKey }) {
            calls++;
            assert.equal(apiKey, syntheticKey);
            await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: rotated.id });
            return { checkoutUrl };
        } });
        try {
            const first = await service.prepareCheckout(input);
            assert.equal((await service.prepareCheckout(input)).attemptId, first.attemptId);
            assert.equal((await db('pagamentos').where({ id: first.attemptId }).first()).credencial_id, credential.id);
            assert.equal(calls, 1);
        } finally { await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: credential.id }); }
    });

    test('expired-day preparation and untrusted financial inputs cannot bind or reserve an order', async () => {
        const order = await orderFixture();
        const service = await orchestrator();
        for (const extra of [{ items: [] }, { valor_total: '0.01' }, { apiKey: syntheticKey }, { options: {} }, { status: 'PAGA' }]) {
            await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID(), ...extra }),
                error => error.code === 'INVALID_REQUEST_ID');
        }
        const expired = await orchestrator(undefined, { now: () => new Date('2026-10-23T02:59:59.000Z') });
        await assert.rejects(expired.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }));
        assert.equal((await db('pedidos').where({ id: order.id }).first()).client_request_id, null);
        assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('missing credential refuses preparation before any idempotency binding', async () => {
        const order = await orderFixture();
        await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: null });
        try {
            const service = await orchestrator();
            await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }),
                error => error.code === 'CREDENTIAL_UNAVAILABLE');
            assert.deepEqual(await db('pedidos').where({ id: order.id }).first(), order);
            assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
        } finally { await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: credential.id }); }
    });

    for (const [codigo, id] of [['CARTAO_CREDITO', 5849], ['CREDITO', 7218]]) {
        test('explicit ' + codigo + '/CREDITO works independently of names and IDs and an uppercase UUID replays safely', async () => {
            const [credit] = await db('metodos_pagamento').insert({ id, nome: 'Dinheiro sintético ' + codigo, codigo, tipo_financeiro: 'CREDITO' }).returning('*');
            const order = await orderFixture({ metodo_pagamento_id: credit.id });
            const requestId = randomUUID();
            let calls = 0;
            const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } });
            const result = await service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId.toUpperCase() });
            assert.equal(result.status, 'AGUARDANDO');
            await db('metodos_pagamento').where({ id: credit.id }).update({ nome: 'Débito sintético renomeado ' + codigo });
            assert.equal((await service.prepareCheckout({ pedidoId: order.id, clientRequestId: requestId })).attemptId, result.attemptId);
            assert.equal(calls, 1);
            assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 1);
            assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
        });
    }

    test('contradictory payment classifications never bind an order, create financial state or dispatch transport', async () => {
        let calls = 0;
        const service = await orchestrator({ async createCheckout() { calls++; return { checkoutUrl }; } });
        for (const [codigo, tipo_financeiro] of [['PIX', 'CREDITO'], ['CARTAO_CREDITO', 'OUTRO'],
            ['CARTAO_CREDITO', 'DEBITO'], ['CARTAO_CREDITO', 'PIX'], ['CREDITO', 'DEBITO'],
            ['CARTAO_DEBITO', 'CREDITO'], ['DINHEIRO', 'CREDITO']]) {
            const original = await db('metodos_pagamento').where({ codigo }).first();
            await db('metodos_pagamento').where({ id: original.id }).update({ tipo_financeiro });
            try {
                const order = await orderFixture({ metodo_pagamento_id: original.id });
                const items = await db('itens_pedido').where({ pedido_id: order.id });
                await assert.rejects(service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() }),
                    error => error.code === 'PAYMENT_METHOD_NOT_MAPPED');
                assert.deepEqual(await db('pedidos').where({ id: order.id }).first(), order);
                assert.deepEqual(await db('itens_pedido').where({ pedido_id: order.id }), items);
                assert.equal(await db('pagamentos').where({ pedido_id: order.id }).count('* as n').first().then(row => Number(row.n)), 0);
            } finally {
                await db('metodos_pagamento').where({ id: original.id }).update({ tipo_financeiro: original.tipo_financeiro });
            }
        }
        assert.equal(calls, 0);
        assert.equal(await db('outbox_eventos').count('* as n').first().then(row => Number(row.n)), 0);
    });

    test('H1 uses a server-configured test prefix and reserves the approved synthetic cent value once', async () => {
        const order = await orderFixture({ valor_total: '1.00' });
        await db('itens_pedido').where({ pedido_id: order.id }).update({ quantidade: 1, preco_unitario: '1.00', subtotal: '1.00' });
        const input = { pedidoId: order.id, clientRequestId: randomUUID() };
        let calls = 0, observed;
        const service = await orchestrator({ async createCheckout({ payload }) { calls++; observed = payload; return { checkoutUrl }; } },
            { orderNsuPrefix: 'H1-MARMITARIA' });
        const first = await service.prepareCheckout(input);
        const second = await service.prepareCheckout(input);
        assert.match(first.orderNsu, new RegExp('^H1-MARMITARIA-' + order.id + '-T1-[a-f0-9-]{36}$'));
        assert.equal(second.orderNsu, first.orderNsu);
        assert.equal(calls, 1);
        assert.equal(observed.order_nsu, first.orderNsu);
        assert.equal(observed.items.length, 1);
        assert.equal(observed.items[0].price, 100);
        assert.equal(observed.options.single_payment, true);
        assert.equal(observed.options.require_delivery_address, false);
        assert.equal(observed.options.assured_installments, 1);
        assert.equal(observed.options.discounts, undefined);
        const payment = await db('pagamentos').where({ pedido_id: order.id }).first();
        assert.equal(payment.order_nsu, first.orderNsu);
        assert.equal(payment.valor_centavos, '100');
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
    });
    test('invalid server prefixes fail before reserving or dispatching any financial request', async () => {
        let calls = 0;
        const client = { async createCheckout() { calls++; return { checkoutUrl }; } };
        const before = await db('pagamentos').select('*');
        for (const orderNsuPrefix of ['', ' ', null, 'H1_TEST', 'H1\nTEST', 'A'.repeat(33), {}]) {
            await assert.rejects(orchestrator(client, { orderNsuPrefix }), error => error.code === 'PREPARATION_BLOCKED' && error.statusCode === 503);
        }
        assert.equal(calls, 0);
        assert.deepEqual(await db('pagamentos').select('*'), before);
    });
    test('late failure cannot downgrade an independently advanced payment or release the kitchen', async () => {
        const order = await orderFixture();
        const service = await orchestrator({ async createCheckout() {
            await db('pagamentos').where({ pedido_id: order.id }).update({ status: 'PAGA' });
            throw new Error(syntheticKey);
        } });
        assert.equal((await service.prepareCheckout({ pedidoId: order.id, clientRequestId: randomUUID() })).status, 'PAGA');
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
        assert.equal(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first(), undefined);
    });
});
