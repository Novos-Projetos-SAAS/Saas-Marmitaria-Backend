import { createHash, randomBytes } from 'node:crypto';
import { createPaymentOrchestrator } from './services/paymentOrchestrator.js';
import { createInfinitepayEventsService } from './services/infinitepayEventsService.js';
import { createPaymentOutboxService } from './services/paymentOutboxService.js';
import { aplicarElegibilidadeOperacional } from './utils/pedidoPaymentPolicy.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function financialHttpError(statusCode) {
    return Object.assign(new Error('Não foi possível processar a solicitação financeira.'), { statusCode });
}
function uuid(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw financialHttpError(400);
    return value.toLowerCase();
}
export async function lockFinancialRequest(trx, requestId) {
    const request = uuid(requestId);
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['infinitepay:create:' + request]);
    // A reserved financial UUID must not become a posterior order when checkout is disabled.
    // It is an idempotency key, never an authorization capability.
    if (await trx('pedidos').where({ client_request_id: request }).first('id')) throw financialHttpError(409);
    return request;
}
function successLocation(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new TypeError('Destino de retorno inválido.');
    return url;
}

// No production transport, event contract or checkout parser is selected here.
// The composition root must supply homologated adapters before enabling this runtime.
export function createInfinitepayRuntime({ db, checkoutClient, checkClient, parseEvent, deliver,
    redirectUrl, webhookUrl, successUrl, receiptOrigins = [], now = () => new Date(),
    creationEnabled, activationCheck = async () => true, dispatchStateAllowed = () => true, environment = process.env, statusReferenceInFragment = true } = {}) {
    if (typeof statusReferenceInFragment !== 'boolean') throw new TypeError('Destino de consulta inválido.');
    if (creationEnabled !== undefined && (typeof creationEnabled !== 'function' || process.env.NODE_ENV !== 'test')) {
        throw new TypeError('Gate de criação simulado permitido somente em testes.');
    }
    const creationGate = creationEnabled ?? (async trx => environment.INFINITEPAY_CHECKOUT_ENABLED === 'true' &&
        (await trx('config_infinitepay').where({ id: 1 }).forShare().first('ativo'))?.ativo === true);
    const destination = successLocation(successUrl);
    const orchestrator = createPaymentOrchestrator({ db, client: checkoutClient, redirectUrl, webhookUrl, now,
        withDispatchPermit: action => db.transaction(async trx => {
            // Deactivation cannot acknowledge while an authorized dispatch still owns this shared lock.
            await trx('config_infinitepay').where({ id: 1 }).forShare().first('id');
            if (!await checkoutEnabled(trx) || dispatchStateAllowed() !== true) throw financialHttpError(503);
            return action();
        }) });
    const events = createInfinitepayEventsService({ db, client: checkClient, parseEvent, receiptOrigins, now });
    const outbox = createPaymentOutboxService({ db, deliver, now });

    async function issueToken(trx, pedidoId, scope, days) {
        const token = randomBytes(32).toString('base64url'), instant = now();
        await trx('pedido_acessos').insert({ pedido_id: pedidoId, token_hash: hash(token), escopo: scope,
            criado_em: instant, expira_em: new Date(instant.getTime() + days * 86400000) });
        return token;
    }
    async function issueAccess(trx, pedidoId) {
        return { access_token: await issueToken(trx, pedidoId, 'TITULAR', 30), status_ref: await issueToken(trx, pedidoId, 'STATUS', 7) };
    }
    async function authorize(token, scope) {
        if (!opaque(token)) throw financialHttpError(404);
        return db.transaction(async trx => {
            const access = await trx('pedido_acessos').where({ token_hash: hash(token), escopo: scope })
                .whereNull('revogado_em').where('expira_em', '>', now()).first();
            if (!access || !await trx('pedidos').where({ id: access.pedido_id, fluxo_pagamento: 'INFINITEPAY' }).whereNull('deletado_em').first('id')) throw financialHttpError(404);
            await trx('pedido_acessos').where({ id: access.id }).update({ ultimo_acesso_em: now() });
            return access.pedido_id;
        });
    }
    async function checkoutEnabled(trx = db) { return await creationGate(trx) === true && await activationCheck(trx) === true; }
    async function resume(pedidoId, input) {
        if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== 'client_request_id')) throw financialHttpError(400);
        const clientRequestId = uuid(input.client_request_id);
        if (!await checkoutEnabled() && !await db('pagamentos').where({ pedido_id: pedidoId }).first('id')) throw financialHttpError(503);
        const result = await orchestrator.prepareCheckout({ pedidoId, clientRequestId });
        return checkoutDto(result);
    }
    function checkoutDto(result) {
        return { fluxo_pagamento: 'INFINITEPAY', pagamento_status: result.status,
            ...(result.status === 'AGUARDANDO' && result.checkoutUrl && new Date(result.validUntil) > now() ? { checkout_url: result.checkoutUrl } : {}),
            ...(result.status === 'INCERTA' || result.status === 'CRIANDO' ? { reconciliacao_necessaria: true } : {}) };
    }
    async function status(pedidoId) {
        return db.transaction(async trx => {
            // A coherent snapshot prevents a paid/released combination from mixed reads.
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const payment = await trx('pagamentos').where({ pedido_id: pedidoId }).orderBy('tentativa_numero', 'desc').first('status');
            const eligible = await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id', pedidoId).first('pedidos.id');
            return { pagamento_status: payment?.status || 'SEM_TENTATIVA', cozinha_liberada: Boolean(eligible) };
        });
    }
    async function receiveReturn(query) {
        if (!opaque(query.r) || (query.order_nsu !== undefined && typeof query.order_nsu !== 'string') ||
            ['transaction_nsu', 'slug'].some(key => query[key] !== undefined && typeof query[key] !== 'string')) throw financialHttpError(400);
        const payment = await db('pagamentos').join('pedidos', 'pedidos.id', 'pagamentos.pedido_id')
            .where('pagamentos.return_nonce_hash', hash(query.r)).where('pedidos.fluxo_pagamento', 'INFINITEPAY')
            .whereNull('pedidos.deletado_em').first('pagamentos.*');
        if (!payment || new Date(payment.valid_until).getTime() + 86400000 <= now().getTime() ||
            query.order_nsu !== payment.order_nsu) throw financialHttpError(400);
        await events.receiveReturn({ orderNsu: payment.order_nsu, transactionNsu: query.transaction_nsu, invoiceSlug: query.slug });
        const ref = await db.transaction(trx => issueToken(trx, payment.pedido_id, 'STATUS', 1));
        // A read-only capability stays out of HTTP access logs and resource referrers.
        const target = new URL(destination);
        if (statusReferenceInFragment) target.hash = new URLSearchParams({ ref }).toString();
        else target.searchParams.set('ref', ref);
        return target.toString();
    }
    async function processPending({ limit = 25 } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Limite de processamento inválido.');
        const result = { events: 0, deliveries: 0, errors: 0 };
        for (let i = 0; i < limit; i++) {
            let event, delivery;
            try { event = await events.processNext(); if (event) result.events++; } catch { result.errors++; }
            try { delivery = await outbox.processNext(); if (delivery) result.deliveries++; } catch { result.errors++; }
            if (!event && !delivery) break;
        }
        return result;
    }
    return { checkoutEnabled, issueAccess, authorize, resume, status, receiveReturn, processPending,
        receiveEvent: raw => events.receive(raw),
        reserveCreation: (trx, pedidoId, clientRequestId) => orchestrator.reserveInTransaction({ pedidoId, clientRequestId }, trx),
        finishCreation: async reservation => checkoutDto(await orchestrator.completeReservation(reservation)) };
}

// Explicit lifecycle only: importing the application never starts a financial worker.
export function startInfinitepayProcessing(runtime, { intervalMs = 1000, onCycle = () => {} } = {}) {
    if (typeof runtime?.processPending !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new TypeError('Worker inválido.');
    let pending, stopped = false;
    const tick = () => {
        if (stopped || pending) return;
        pending = Promise.resolve().then(() => runtime.processPending()).then(onCycle)
            .catch(() => onCycle({ errors: 1 })).finally(() => { pending = undefined; });
    };
    const timer = setInterval(tick, intervalMs); timer.unref(); tick();
    return { async stop() { stopped = true; clearInterval(timer); await pending; } };
}
