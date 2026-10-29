import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { createInfinitepayRuntime } from '../../src/infinitepayRuntime.js';
import { createCheckoutSessionService } from '../../src/services/checkoutSessionService.js';
import { parseObservedInfinitepayEvent } from '../../src/services/infinitepayObservedContracts.js';
import paymentRoutes from '../../src/routes/Pagamentos.Routes.js';

describe('phase 6 checkout resilience with isolated ownership and credentials', { concurrency: false }, () => {
let fixture, db, method, size, credential, savedEnvironment;
const clock = new Date('2026-10-29T15:00:00Z');
const originalKey = 'SYNTHETIC_PHASE6_ORIGINAL_KEY';
before(async () => {
    savedEnvironment = Object.fromEntries(['NODE_ENV', 'INFINITEPAY_ENCRYPTION_KEY', 'INFINITEPAY_ENCRYPTION_KEYS',
        'INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(key => [key, process.env[key]]));
    process.env.NODE_ENV = 'test'; process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.INFINITEPAY_ENCRYPTION_KEYS; process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
    fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
    [method] = await db('metodos_pagamento').insert({ nome: 'Pix sintético fase6', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
    [size] = await db('tamanhos_marmitas').insert({ nome: 'Tamanho sintético fase6', preco_base: 20 }).returning('*');
    [credential] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-phase6', ...encryptApiKey(originalKey, 'synthetic-phase6') }).returning('*');
    await db('config_infinitepay').where({ id: 1 }).update({ handle: credential.handle, credencial_atual_id: credential.id });
});
after(async () => {
    try { await fixture?.close(); }
    finally {
        for (const [key, value] of Object.entries(savedEnvironment ?? {})) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

function composition() {
    const returns = new Map(), deliveries = [], checks = [];
    const runtime = createInfinitepayRuntime({ db, now: () => new Date(clock), creationEnabled: async () => true,
        checkoutClient: { async createCheckout({ apiKey, payload }) {
            assert.equal(apiKey, originalKey); returns.set(payload.order_nsu, payload.redirect_url);
            return { checkoutUrl: 'https://checkout.infinitepay.io/SYNTHETIC-PHASE6', invoiceSlug: 'SYNTHETIC-INVOICE-' + payload.order_nsu };
        } }, checkClient: { async checkPayment(input) {
            checks.push(input);
            assert.equal(input.apiKey, originalKey); assert.equal(input.handle, 'synthetic-phase6');
            return { paid: true, amount: 2000, paidAmount: 2000, installments: 1, captureMethod: 'pix',
                receiptUrl: 'https://recibo.infinitepay.io/' + input.transactionNsu };
        } }, parseEvent: parseObservedInfinitepayEvent, receiptOrigins: ['https://recibo.infinitepay.io'],
        deliver: async dto => { deliveries.push(dto); },
        redirectUrl: 'https://backend.invalid.test/pagamentos/infinitepay/retorno',
        webhookUrl: 'https://backend.invalid.test/pagamentos/infinitepay/webhook', successUrl: 'https://shop.invalid.test/pedido/sucesso' });
    const sessions = createCheckoutSessionService({ db, now: () => new Date(clock), runtime: () => runtime });
    return { runtime, sessions, returns, deliveries, checks };
}
async function order(journey) {
    const owner = await journey.sessions.open();
    const id = await db.transaction(async trx => {
        const reserved = await journey.sessions.lockCreation(trx, owner.session_token, owner.client_request_id, { synthetic: true });
        const [row] = await trx('pedidos').insert({ nome_cliente: 'CLIENTE SINTETICO FASE6', telefone_cliente: '11999999999',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: 20, fluxo_pagamento: 'INFINITEPAY' }).returning('*');
        await trx('itens_pedido').insert({ pedido_id: row.id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: 20, subtotal: 20 });
        await journey.sessions.attach(trx, reserved, row.id); return row.id;
    });
    await journey.runtime.resume(id, { client_request_id: owner.client_request_id });
    const payment = await db('pagamentos').where({ pedido_id: id }).first();
    const event = { event_type: 'paid', order_nsu: payment.order_nsu, invoice_slug: payment.invoice_slug,
        transaction_nsu: 'SYNTHETIC-PHASE6-TXN-' + payment.id };
    return { id, owner, payment, event };
}
async function pay(journey, f) {
    await journey.runtime.receiveEvent(f.event); await journey.runtime.processPending({ limit: 20 });
    assert.equal((await db('pagamentos').where({ id: f.payment.id }).first()).status, 'PAGA');
}

test('owned tracking retrieves a historical receipt by order only for its live owning session', async () => {
    const journey = composition(), f = await order(journey);
    assert.equal(typeof journey.sessions.lookupOrder, 'function');
    const pending = await journey.sessions.lookupOrder(f.owner.session_token, f.id);
    assert.equal(pending.pedido_id, f.id); assert.equal(pending.pagamento_status, 'AGUARDANDO');
    assert.equal(pending.cozinha_liberada, false); assert.equal(pending.receipt_url, undefined);
    await pay(journey, f);
    await journey.sessions.newRequest(f.owner.session_token);
    const historical = await journey.sessions.lookupOrder(f.owner.session_token, f.id);
    assert.equal(historical.pedido_id, f.id); assert.equal(historical.client_request_id, f.owner.client_request_id);
    assert.equal(historical.receipt_url, 'https://recibo.infinitepay.io/' + f.event.transaction_nsu);
    assert.equal((await journey.sessions.lookup(f.owner.session_token)).pedido_id, null);
    const stranger = await journey.sessions.open();
    for (const token of [stranger.session_token, undefined, randomBytes(32).toString('base64url')]) {
        await assert.rejects(journey.sessions.lookupOrder(token, f.id), error => error.statusCode === 404);
    }
    for (const id of ['01', 0, -1, '11999999999', '1.5']) await assert.rejects(journey.sessions.lookupOrder(f.owner.session_token, id), error => error.statusCode === 404);
    const expiredSessions = createCheckoutSessionService({ db, now: () => new Date(clock.getTime() + 31 * 86400000) });
    await assert.rejects(expiredSessions.lookupOrder(f.owner.session_token, f.id), error => error.statusCode === 404);
    await db('checkout_sessoes').where({ requisicao_atual: (await journey.sessions.open(f.owner.session_token)).client_request_id }).update({ revogado_em: clock });
    await assert.rejects(journey.sessions.lookupOrder(f.owner.session_token, f.id), error => error.statusCode === 404);
});

test('T08 HTTP return processed before webhook converges to one paid release and one delivery', async () => {
    const journey = composition(), f = await order(journey), app = express();
    app.use(express.json()); app.locals.infinitepayRuntime = journey.runtime; app.use('/pagamentos', paymentRoutes);
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ status: 'fail' }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        const returned = new URL(journey.returns.get(f.payment.order_nsu));
        returned.searchParams.set('order_nsu', f.payment.order_nsu); returned.searchParams.set('transaction_nsu', f.event.transaction_nsu);
        returned.searchParams.set('slug', f.payment.invoice_slug);
        const response = await fetch(base + returned.pathname + returned.search, { redirect: 'manual' });
        assert.equal(response.status, 303); assert.equal(journey.checks.length, 0);
        assert.equal((await db('pedidos').where({ id: f.id }).first()).liberado_cozinha_em, null);
        const target = new URL(response.headers.get('location'));
        assert.equal(target.search, ''); const ref = new URLSearchParams(target.hash.slice(1)).get('ref');
        const read = async () => (await (await fetch(base + '/pagamentos/consulta?ref=' + ref)).json()).data;
        assert.equal((await read()).cozinha_liberada, false);
        await journey.runtime.processPending({ limit: 20 });
        assert.equal((await read()).pagamento_status, 'PAGA'); assert.equal((await read()).cozinha_liberada, true);
        for (let n = 0; n < 3; n++) assert.equal((await fetch(base + '/pagamentos/infinitepay/webhook', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.event)
        })).status, 200);
        await journey.runtime.processPending({ limit: 20 });
        assert.equal(Number((await db('outbox_eventos').where({ pedido_id: f.id, tipo: 'PEDIDO_LIBERADO' }).count('* as n').first()).n), 1);
        assert.equal(journey.deliveries.filter(row => row.pedidoId === f.id).length, 1);
        assert.equal((await read()).pagamento_status, 'PAGA');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('T18 rotation and removal of current credentials preserve independent verification of the original charge', async () => {
    const journey = composition(), f = await order(journey);
    const [replacement] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-phase6-other',
        ...encryptApiKey('SYNTHETIC_PHASE6_REPLACEMENT_KEY', 'synthetic-phase6-other') }).returning('*');
    try {
        await db('config_infinitepay').where({ id: 1 }).update({ ativo: false, handle: replacement.handle, credencial_atual_id: replacement.id });
        await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: null });
        await pay(journey, f);
        assert.equal(journey.checks.length, 1);
        assert.equal(journey.checks[0].apiKey, originalKey); assert.equal(journey.checks[0].handle, credential.handle);
        const persisted = await db('pagamentos').where({ id: f.payment.id }).first();
        assert.equal(persisted.credencial_id, credential.id); assert.equal(persisted.status, 'PAGA');
        assert.ok((await db('pedidos').where({ id: f.id }).first()).liberado_cozinha_em);
        const exposed = await journey.sessions.lookup(f.owner.session_token);
        assert.doesNotMatch(JSON.stringify(exposed), /SYNTHETIC_PHASE6_ORIGINAL_KEY|SYNTHETIC_PHASE6_REPLACEMENT_KEY|api_key|ciphertext/);
    } finally { await db('config_infinitepay').where({ id: 1 }).update({ handle: credential.handle, credencial_atual_id: credential.id }); }
});
});
