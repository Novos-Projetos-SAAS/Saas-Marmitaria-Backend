import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { aplicarElegibilidadeOperacional } from '../../src/utils/pedidoPaymentPolicy.js';
import { createInfinitepayCheckClient } from '../../src/services/infinitepayCheckClient.js';

const apiKey = 'SYNTHETIC_EVENT_KEY_NEVER_LOG';
const baseTime = new Date('2026-10-23T15:00:00Z');
const receiptUrl = 'https://receipt.invalid.test/synthetic-receipt';
const positive = { paid: true, amount: 2000, paidAmount: 2010, installments: 1, captureMethod: 'pix' };

describe('internal financial event processing', { concurrency: false }, () => {
    let fixture, db, method, size, credential, previousKey;
    beforeEach(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
        previousKey = process.env.INFINITEPAY_ENCRYPTION_KEY;
        process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
        [method] = await db('metodos_pagamento').insert({ nome: 'Método sintético', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
        [size] = await db('tamanhos_marmitas').insert({ nome: 'M sintética', preco_base: '20.00' }).returning('*');
        [credential] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-store', ...encryptApiKey(apiKey, 'synthetic-store') }).returning('*');
    });
    afterEach(async () => {
        try { if (fixture) await fixture.close(); }
        finally { if (previousKey === undefined) delete process.env.INFINITEPAY_ENCRYPTION_KEY; else process.env.INFINITEPAY_ENCRYPTION_KEY = previousKey; }
    });
    async function setup(overrides = {}) {
        const [order] = await db('pedidos').insert({ nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id,
            fluxo_pagamento: 'INFINITEPAY', status: 'Pendente', valor_total: '20.00', ...overrides }).returning('*');
        await db('itens_pedido').insert({ pedido_id: order.id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: '20.00', subtotal: '20.00' });
        const [payment] = await db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1, order_nsu: 'SYNTHETIC-' + randomUUID(),
            status: 'INCERTA', valor_centavos: 2000, valid_until: new Date('2026-10-24T02:59:59Z'),
            credencial_id: credential.id, handle_snapshot: credential.handle, invoice_slug: 'SYNTHETIC-SLUG-' + randomUUID() }).returning('*');
        const event = { type: 'paid', order_nsu: payment.order_nsu, transaction_nsu: 'SYNTHETIC-TX-' + randomUUID(), invoice_slug: payment.invoice_slug };
        return { order, payment, event };
    }
    function parseEvent(raw) {
        return { type: raw.type, orderNsu: raw.order_nsu, transactionNsu: raw.transaction_nsu,
            invoiceSlug: raw.invoice_slug, slug: raw.slug };
    }
    async function service(options = {}) {
        let module;
        try { module = await import('../../src/services/infinitepayEventsService.js'); }
        catch (error) { assert.fail('Processador interno ausente: ' + error.code); }
        return module.createInfinitepayEventsService({ db, parseEvent,
            client: { async checkPayment(input) { assert.equal(input.apiKey, apiKey); return { ...positive }; } },
            receiptOrigins: ['https://receipt.invalid.test'], now: () => new Date(baseTime), retryMs: 100, leaseMs: 1000, ...options });
    }
    async function savedPayment(payment) { return db('pagamentos').where({ id: payment.id }).first(); }
    async function assertBlocked(order) {
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
        assert.equal(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first(), undefined);
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: order.id }).count('* as n').first()).n), 0);
    }
    function failTransaction(number) {
        let count = 0;
        const wrapped = table => db(table);
        wrapped.raw = db.raw.bind(db); wrapped.fn = db.fn;
        wrapped.transaction = callback => db.transaction(async trx => {
            count++;
            if (count === number) throw new Error(apiKey + ' synthetic persistence failure');
            return callback(trx);
        });
        return wrapped;
    }

    test('receipt persistence is deduplicated, canonical and excludes webhook claims, PII and credentials', async () => {
        const { event, order } = await setup(); const s = await service();
        const raw = { ...event, paid: true, receipt_url: receiptUrl, customer: { name: 'PII_SENTINEL' }, api_key: apiKey };
        const first = await s.receive(raw);
        const duplicate = await s.receive(Object.fromEntries(Object.entries(raw).reverse()));
        assert.equal(first.eventId, duplicate.eventId);
        const row = await db('pagamentos_eventos').where({ id: first.eventId }).first();
        assert.match(row.event_key, /^ip:event:v1:[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(row).includes(apiKey), false);
        assert.equal(JSON.stringify(row).includes('PII_SENTINEL'), false);
        assert.equal(JSON.stringify(row).includes(receiptUrl), false);
        await assertBlocked(order);
    });
    test('different events sharing order_nsu are retained rather than deduplicated by the order alone', async () => {
        const { event } = await setup(); const s = await service();
        const a = await s.receive({ ...event, event_id: 'SYNTHETIC-A' });
        const b = await s.receive({ ...event, event_id: 'SYNTHETIC-B' });
        assert.notEqual(a.eventId, b.eventId);
    });
    test('a durable event does not confirm until an independent authenticated query outside the database transaction', async () => {
        const { event, order, payment } = await setup(); let calls = 0;
        const s = await service({ client: { async checkPayment(input) {
            calls++; assert.equal(input.handle, credential.handle); assert.equal(input.orderNsu, payment.order_nsu);
            assert.equal(input.transactionNsu, event.transaction_nsu); assert.equal(input.invoiceSlug, payment.invoice_slug);
            await db.transaction(async trx => { await trx('pedidos').where({ id: order.id }).forUpdate().noWait().first(); });
            return { ...positive, receiptUrl };
        } } });
        await s.receive({ ...event, receipt_url: 'https://attacker.invalid.test/receipt' });
        await assertBlocked(order);
        assert.equal((await s.processNext()).status, 'CONCLUIDO');
        const row = await savedPayment(payment);
        assert.equal(row.status, 'PAGA'); assert.equal(row.valor_base_provider_centavos, '2000');
        assert.equal(row.valor_pago_provider_centavos, '2010'); assert.equal(row.transaction_nsu, event.transaction_nsu);
        assert.equal(row.receipt_url, receiptUrl); assert.ok(row.provider_verified_at); assert.ok(row.pago_em);
        assert.ok((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em);
        assert.ok(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first());
        const releases = await db('outbox_eventos').where({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO' });
        assert.equal(releases.length, 1); assert.equal(releases[0].chave_unica, 'pedido_liberado:' + order.id);
        assert.equal(JSON.stringify(releases).includes(receiptUrl), false);
        assert.equal(calls, 1);
    });
    test('an unverified webhook claiming paid remains pending when payment_check returns paid=false', async () => {
        const { event, order, payment } = await setup();
        const s = await service({ client: { async checkPayment() { return { paid: false }; } } });
        await s.receive({ ...event, paid: true, amount: 2000, receipt_url: receiptUrl });
        const result = await s.processNext(); assert.equal(result.status, 'PENDENTE');
        assert.equal((await savedPayment(payment)).status, 'INCERTA');
        assert.equal((await savedPayment(payment)).receipt_url, null); await assertBlocked(order);
    });
    test('missing identifiers stay recoverable and a later event can supply enough data without browser return', async () => {
        const { event, order } = await setup(); const s = await service();
        const pending = await s.receive({ type: 'paid', order_nsu: event.order_nsu });
        assert.equal((await s.processNext()).status, 'PENDENTE_IDENTIFICACAO'); await assertBlocked(order);
        await s.receive(event); assert.equal((await s.processNext()).status, 'CONCLUIDO');
        const restarted = await service({ now: () => new Date(baseTime.getTime() + 200) });
        assert.equal((await restarted.processNext()).eventId, pending.eventId);
        assert.equal((await db('pagamentos_eventos').where({ id: pending.eventId }).first()).status_processamento, 'CONCLUIDO');
    });
    test('unknown order correlation never queries the provider or creates a financial record', async () => {
        let calls = 0; const s = await service({ client: { async checkPayment() { calls++; return positive; } } });
        await s.receive({ type: 'paid', order_nsu: 'SYNTHETIC-NOT-FOUND', transaction_nsu: 'TX', slug: 'SLUG' });
        assert.equal((await s.processNext()).status, 'PENDENTE_IDENTIFICACAO'); assert.equal(calls, 0);
    });
    test('a conflicting invoice identifier cannot overwrite the reserved reference or authorize a query', async () => {
        const { event, order, payment } = await setup(); let calls = 0;
        const s = await service({ client: { async checkPayment() { calls++; return positive; } } });
        await s.receive({ ...event, invoice_slug: 'SYNTHETIC-WRONG' });
        assert.equal((await s.processNext()).status, 'ERRO');
        assert.equal((await savedPayment(payment)).invoice_slug, payment.invoice_slug);
        assert.equal(calls, 0); await assertBlocked(order);
    });
    test('divergent authenticated amount is recorded without release, even if paid_amount matches', async () => {
        const { event, order, payment } = await setup();
        const s = await service({ client: { async checkPayment() { return { ...positive, amount: 1999, paidAmount: 2000 }; } } });
        await s.receive(event); assert.equal((await s.processNext()).status, 'ERRO');
        assert.equal((await savedPayment(payment)).status, 'DIVERGENTE'); await assertBlocked(order);
        const next = await service({ now: () => new Date(baseTime.getTime() + 200) });
        await next.processNext(); await assertBlocked(order);
    });
    test('provider identity mismatch is rejected even if paid and amount appear valid', async () => {
        const { event, order } = await setup();
        const s = await service({ client: { async checkPayment() { return { ...positive,
            identifiers: { orderNsu: 'SYNTHETIC-OTHER', transactionNsu: event.transaction_nsu, invoiceSlug: event.invoice_slug } }; } } });
        await s.receive(event); assert.equal((await s.processNext()).status, 'ERRO'); await assertBlocked(order);
    });
    test('query errors remain pending, sanitized, and recover after service recreation', async () => {
        const { event, order } = await setup();
        const s = await service({ client: { async checkPayment() { throw new Error(apiKey + ' RAW_PROVIDER_BODY'); } } });
        const received = await s.receive(event); assert.equal((await s.processNext()).status, 'PENDENTE'); await assertBlocked(order);
        const row = await db('pagamentos_eventos').where({ id: received.eventId }).first();
        assert.equal(JSON.stringify(row).includes(apiKey), false); assert.equal(JSON.stringify(row).includes('RAW_PROVIDER_BODY'), false);
        const restarted = await service({ now: () => new Date(baseTime.getTime() + 200) });
        assert.equal((await restarted.processNext()).status, 'CONCLUIDO');
    });
    test('failure of the confirmation transaction rolls back payment, kitchen release and outbox together', async () => {
        const { event, order, payment } = await setup(); const s = await service({ db: failTransaction(2) });
        await s.receive(event); await s.processNext();
        assert.equal((await savedPayment(payment)).status, 'INCERTA'); await assertBlocked(order);
        const restarted = await service({ now: () => new Date(baseTime.getTime() + 200) });
        assert.equal((await restarted.processNext()).status, 'CONCLUIDO');
    });
    test('failure after confirmation leaves a leased event recoverable without a second operational release', async () => {
        const { event, order } = await setup(); const s = await service({ db: failTransaction(3) });
        const received = await s.receive(event);
        await assert.rejects(s.processNext(), error => !JSON.stringify(error).includes(apiKey));
        assert.equal((await db('pagamentos_eventos').where({ id: received.eventId }).first()).status_processamento, 'PROCESSANDO');
        assert.ok((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em);
        const restarted = await service({ now: () => new Date(baseTime.getTime() + 1100) });
        assert.equal((await restarted.processNext()).status, 'CONCLUIDO');
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO' }).count('* as n').first()).n), 1);
    });
    test('two simultaneous confirmations produce exactly one persistent kitchen release', async () => {
        const { event, order } = await setup(); let arrived = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        const s = await service({ client: { async checkPayment() { if (++arrived === 2) release(); await gate; return { ...positive }; } } });
        await s.receive({ ...event, event_id: 'CONCURRENT-A' }); await s.receive({ ...event, event_id: 'CONCURRENT-B' });
        const results = await Promise.all([s.processNext(), s.processNext()]);
        assert.equal(results.every(row => row.status === 'CONCLUIDO'), true);
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO' }).count('* as n').first()).n), 1);
    });
    test('two orders cannot consume the same external financial identity concurrently', async () => {
        const first = await setup(); const second = await setup();
        second.event.transaction_nsu = first.event.transaction_nsu;
        const s = await service(); await s.receive(first.event); await s.receive(second.event);
        const results = await Promise.all([s.processNext(), s.processNext()]);
        assert.equal(results.filter(row => row.status === 'CONCLUIDO').length, 1);
        const released = await db('pedidos').whereIn('id', [first.order.id, second.order.id]).whereNotNull('liberado_cozinha_em');
        assert.equal(released.length, 1);
    });
    test('browser timing is irrelevant: duplicate events before and after prior processing do not release twice', async () => {
        const { event, order } = await setup(); const s = await service();
        const first = await s.receive(event); await s.receive(event); await s.processNext();
        assert.equal((await s.receive(event)).eventId, first.eventId); assert.equal(await s.processNext(), null);
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: order.id, tipo: 'PEDIDO_LIBERADO' }).count('* as n').first()).n), 1);
    });
    test('out-of-order pending events do not downgrade paid or settled evidence', async () => {
        const { event, payment } = await setup(); let proof = { ...positive, financialState: 'LIQUIDADA' };
        const s = await service({ client: { async checkPayment() { return proof; } } });
        await s.receive({ ...event, type: 'settled' }); await s.processNext();
        assert.equal((await savedPayment(payment)).status, 'LIQUIDADA');
        proof = { paid: false }; await s.receive({ ...event, type: 'created' }); await s.processNext();
        assert.equal((await savedPayment(payment)).status, 'LIQUIDADA');
    });
    test('refund requires independently verified evidence and preserves a prior kitchen release', async () => {
        const { event, order, payment } = await setup(); let proof = { ...positive };
        const s = await service({ client: { async checkPayment() { return proof; } } });
        await s.receive(event); await s.processNext();
        const released = (await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em;
        await s.receive({ ...event, type: 'refunded' }); await s.processNext();
        assert.equal((await savedPayment(payment)).status, 'PAGA');
        proof = { ...positive, financialState: 'ESTORNADA' };
        await s.receive({ ...event, type: 'refunded', event_id: 'SYNTHETIC-INDEPENDENT-REFUND' }); await s.processNext();
        assert.equal((await savedPayment(payment)).status, 'ESTORNADA');
        assert.deepEqual((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, released);
        assert.ok(await aplicarElegibilidadeOperacional(db('pedidos')).where('pedidos.id', order.id).first());
    });
    test('webhook receipt and event type cannot act as proof or change financial terminal states', async () => {
        const { event, order, payment } = await setup();
        const s = await service({ client: { async checkPayment() { return { paid: false }; } } });
        for (const type of ['settled', 'refunded', 'canceled', 'payment_failed']) {
            await s.receive({ ...event, type, receipt_url: receiptUrl }); await s.processNext();
        }
        assert.equal((await savedPayment(payment)).status, 'INCERTA'); await assertBlocked(order);
    });
    test('untrusted receipt origins are never saved even after valid confirmation', async () => {
        const { event, payment } = await setup();
        const s = await service({ client: { async checkPayment() { return { ...positive, receiptUrl: 'https://evil.invalid.test/receipt' }; } } });
        await s.receive(event); await s.processNext(); assert.equal((await savedPayment(payment)).receipt_url, null);
    });
    test('a posterior order is never converted, released or modified by financial event processing', async () => {
        const { event, order, payment } = await setup({ fluxo_pagamento: 'POSTERIOR' }); const s = await service();
        await s.receive(event); assert.equal((await s.processNext()).status, 'ERRO');
        assert.deepEqual(await db('pedidos').where({ id: order.id }).first(), order);
        assert.deepEqual(await savedPayment(payment), payment);
    });
    test('an expired worker cannot commit a stale financial result after its lease is reclaimed', async () => {
        const { event, order } = await setup(); let entered, release;
        const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
        const old = await service({ client: { async checkPayment() { entered(); await gate; return { ...positive }; } } });
        const received = await old.receive(event); const stale = old.processNext(); await started;
        const replacement = await service({ now: () => new Date(baseTime.getTime() + 1100), client: { async checkPayment() { return { paid: false }; } } });
        assert.equal((await replacement.processNext()).status, 'PENDENTE'); release(); await stale;
        await assertBlocked(order);
        assert.equal((await db('pagamentos_eventos').where({ id: received.eventId }).first()).status_processamento, 'PENDENTE');
    });
    test('invalid, oversized or ambiguous events fail safely without persisting or logging raw data', async () => {
        const s = await service();
        for (const raw of [null, [], { type: 'unknown' }, { type: 'paid', order_nsu: '   ' },
            { type: 'paid', order_nsu: 'x', invoice_slug: 'one', slug: 'two' }, { type: 'paid', padding: 'x'.repeat(33000) }]) {
            await assert.rejects(s.receive(raw), error => !JSON.stringify(error).includes(apiKey));
        }
    });
    test('a snapshot changed while the query is in flight cannot be silently accepted as the original charge', async () => {
        const { event, order, payment } = await setup();
        const s = await service({ client: { async checkPayment() {
            await db('pedidos').where({ id: order.id }).update({ valor_total: '10.00' });
            await db('pagamentos').where({ id: payment.id }).update({ valor_centavos: 1000 });
            return { ...positive, amount: 1000, paidAmount: 1000 };
        } } });
        await s.receive(event); assert.equal((await s.processNext()).status, 'ERRO'); await assertBlocked(order);
    });
    test('the actual prepared client uses only an injected transport and the attempt credential for verification', async () => {
        const { event, payment } = await setup(); let calls = 0;
        const client = createInfinitepayCheckClient({
            async transport(url, request) {
                calls++; assert.equal(url, 'https://api.checkout.infinitepay.io/payment_check');
                assert.equal(request.headers['X-Api-Key'], apiKey); assert.equal(request.redirect, 'error');
                assert.deepEqual(JSON.parse(request.body), { handle: credential.handle, order_nsu: payment.order_nsu,
                    transaction_nsu: event.transaction_nsu, slug: event.invoice_slug });
                return { status: 200, async json() { return { success: true, paid: true, amount: 2000, paid_amount: 2010, installments: 1, capture_method: 'pix' }; } };
            },
            parsePaymentCheck: raw => ({ paid: raw.paid, amount: raw.amount, paidAmount: raw.paid_amount,
                installments: raw.installments, captureMethod: raw.capture_method })
        });
        const s = await service({ client }); await s.receive(event);
        assert.equal((await s.processNext()).status, 'CONCLUIDO'); assert.equal(calls, 1);
        assert.equal((await savedPayment(payment)).status, 'PAGA');
    });
    test('exhausted crashed event leases become reconciliation errors without another query', async () => {
        const { event } = await setup(); let calls = 0;
        const s = await service({ db: failTransaction(3), maxAttempts: 1, client: { async checkPayment() { calls++; return positive; } } });
        const received = await s.receive(event); await assert.rejects(s.processNext());
        const next = await service({ maxAttempts: 1, now: () => new Date(baseTime.getTime() + 1100),
            client: { async checkPayment() { calls++; return positive; } } });
        assert.equal((await next.processNext()).status, 'ERRO'); assert.equal(calls, 1);
        const row = await db('pagamentos_eventos').where({ id: received.eventId }).first();
        assert.equal(row.locked_by, null); assert.equal(row.locked_until, null);
        assert.equal(row.ultimo_erro, 'RECONCILIATION_REQUIRED');
    });
    test('a late confirmed payment restores the charge-blocking invariant of an expired attempt', async () => {
        const { event, payment } = await setup();
        await db('pagamentos').where({ id: payment.id }).update({ status: 'EXPIRADA', bloqueia_nova_cobranca: false });
        const s = await service(); await s.receive(event);
        assert.equal((await s.processNext()).status, 'CONCLUIDO');
        const row = await savedPayment(payment);
        assert.equal(row.status, 'PAGA'); assert.equal(row.bloqueia_nova_cobranca, true);
    });
    test('a late confirmation conflicting with another chargeable attempt remains pending for reconciliation', async () => {
        const { event, order, payment } = await setup();
        await db('pagamentos').where({ id: payment.id }).update({ status: 'EXPIRADA', bloqueia_nova_cobranca: false });
        await db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 2, order_nsu: 'SYNTHETIC-SECOND-' + randomUUID(),
            status: 'AGUARDANDO', bloqueia_nova_cobranca: true, valor_centavos: 2000, valid_until: new Date('2026-10-24T02:59:59Z') });
        const s = await service(); await s.receive(event);
        assert.equal((await s.processNext()).status, 'PENDENTE'); await assertBlocked(order);
        assert.equal((await savedPayment(payment)).status, 'EXPIRADA');
    });
});
