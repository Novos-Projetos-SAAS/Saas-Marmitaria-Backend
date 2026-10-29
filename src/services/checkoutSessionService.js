import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { financialHttpError } from '../infinitepayRuntime.js';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';
import { providerOrigins } from '../config/infinitepayProviderOrigins.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const csrf = token => createHash('sha256').update('checkout-csrf-v1\0' + token).digest('base64url');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .filter(key => key !== 'client_request_id').map(key => [key, canonical(value[key])]));
    return value;
}
function allowedUrl(value, origin) {
    try {
        if (typeof value !== 'string' || /[\s\p{C}\\]/u.test(value)) return null;
        const url = new URL(value);
        return url.origin === origin && !url.username && !url.password && !url.hash && url.href === value ? value : null;
    } catch { return null; }
}
export function validatedReceipt(payment) {
    const value = allowedUrl(payment?.receipt_url, providerOrigins().receiptOrigin);
    if (!value || !['PAGA','LIQUIDADA','ESTORNADA'].includes(payment.status) || !payment.provider_verified_at || !payment.pago_em) return null;
    const url = new URL(value);
    if (url.search || /%(?:2f|5c|2e|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
        !url.pathname.split('/').includes(payment.transaction_nsu)) return null;
    return value;
}

export async function availableReceiptOrders(db, ids) {
    if (!ids.length) return new Set();
    const eligible = await aplicarElegibilidadeOperacional(db('pedidos')).whereIn('pedidos.id', ids)
        .whereNull('pedidos.deletado_em').where('pedidos.fluxo_pagamento', 'INFINITEPAY').select('pedidos.id');
    const payments = await db('pagamentos').whereIn('pedido_id', eligible.map(row => row.id))
        .distinctOn('pedido_id').orderBy('pedido_id').orderBy('tentativa_numero', 'desc');
    return new Set(payments.filter(payment => validatedReceipt(payment)).map(payment => payment.pedido_id));
}

export function createCheckoutSessionService({ db, now = () => new Date(), runtime = () => null } = {}) {
    async function authorize(token, csrfToken, trx = db, lock = false) {
        if (!opaque(token)) throw financialHttpError(404);
        const query = trx('checkout_sessoes').where({ token_hash: hash(token) }).whereNull('revogado_em').where('expira_em', '>', now());
        const session = await (lock ? query.forUpdate() : query).first();
        if (!session) throw financialHttpError(404);
        if (csrfToken !== undefined && (!opaque(csrfToken) || !timingSafeEqual(Buffer.from(csrfToken), Buffer.from(csrf(token))))) throw financialHttpError(403);
        return session;
    }
    async function open(token) {
        let session;
        if (token !== undefined) session = await authorize(token);
        else {
            token = randomBytes(32).toString('base64url');
            session = { token_hash: hash(token), requisicao_atual: randomUUID(), criado_em: now(), expira_em: new Date(now().getTime() + 30 * 86400000) };
            await db.transaction(async trx => {
                await trx('checkout_sessoes').insert(session);
                await trx('checkout_requisicoes').insert({ id: session.requisicao_atual, sessao_hash: session.token_hash });
            });
        }
        return { session_token: token, csrf_token: csrf(token), client_request_id: session.requisicao_atual, expires_at: new Date(session.expira_em).toISOString() };
    }
    async function lockCreation(trx, token, requestId, input) {
        const session = await authorize(token, undefined, trx, true);
        if (!uuid(requestId)) throw financialHttpError(400);
        const row = await trx('checkout_requisicoes').where({ id: requestId, sessao_hash: session.token_hash }).forUpdate().first();
        if (!row) throw financialHttpError(404);
        const payloadHash = hash(JSON.stringify(canonical(input)));
        if (row.pedido_id && row.payload_hash !== payloadHash) throw financialHttpError(409);
        return { row, payloadHash, replay: row.pedido_id !== null, pedidoId: row.pedido_id };
    }
    async function attach(trx, reserved, pedidoId) {
        const changed = await trx('checkout_requisicoes').where({ id: reserved.row.id, sessao_hash: reserved.row.sessao_hash })
            .whereNull('pedido_id').update({ pedido_id: pedidoId, payload_hash: reserved.payloadHash });
        if (changed !== 1) throw financialHttpError(409);
    }
    async function lookup(token, requestId) {
        return db.transaction(async trx => {
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const session = await authorize(token, undefined, trx);
            const id = requestId ?? session.requisicao_atual;
            if (!uuid(id)) throw financialHttpError(404);
            const row = await trx('checkout_requisicoes').where({ id, sessao_hash: session.token_hash }).first();
            if (!row) throw financialHttpError(404);
            if (!row.pedido_id) return { client_request_id: id, pedido_id: null };
            const order = await trx('pedidos').where({ id: row.pedido_id }).whereNull('deletado_em').first();
            if (!order) throw financialHttpError(404);
            const payment = await trx('pagamentos').where({ pedido_id: order.id }).orderBy('tentativa_numero', 'desc').first();
            const released = Boolean(await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id', order.id).first('pedidos.id'));
            const link = payment?.status === 'AGUARDANDO' && new Date(payment.valid_until) > now()
                ? allowedUrl(payment.checkout_url, providerOrigins().checkoutOrigin) : null;
            const receipt = released ? validatedReceipt(payment) : null;
            return { client_request_id: id, pedido_id: order.id, total: Number(order.valor_total), fluxo_pagamento: order.fluxo_pagamento,
                pedido_status: order.status, pagamento_status: payment?.status ?? 'POSTERIOR', cozinha_liberada: released,
                ...(link ? { checkout_url: link } : {}), ...(receipt ? { receipt_url: receipt } : {}) };
        });
    }
    async function lookupOrder(token, pedidoId) {
        const id = String(pedidoId);
        if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) throw financialHttpError(404);
        const session = await authorize(token);
        const owned = await db('checkout_requisicoes').where({ sessao_hash: session.token_hash, pedido_id: Number(id) }).first('id');
        if (!owned) throw financialHttpError(404);
        return lookup(token, owned.id);
    }
    async function lookupStatus(token, statusRef) {
        const session = await authorize(token);
        if (!runtime()) throw financialHttpError(503);
        const pedidoId = await runtime().authorize(statusRef, 'STATUS');
        const owned = await db('checkout_requisicoes').where({ sessao_hash: session.token_hash, pedido_id: pedidoId }).first('id');
        return owned ? lookup(token, owned.id) : runtime().status(pedidoId);
    }
    async function resume(token, requestId) {
        const order = await lookup(token, requestId);
        if (!order.pedido_id || order.fluxo_pagamento !== 'INFINITEPAY' || !runtime()) throw financialHttpError(409);
        // An owned durable attempt must already exist; recovery cannot create a missing charge.
        if (!await db('pagamentos').where({ pedido_id: order.pedido_id }).first('id')) throw financialHttpError(409);
        await runtime().resume(order.pedido_id, { client_request_id: order.client_request_id });
        return lookup(token, requestId);
    }
    async function newRequest(token) {
        await db.transaction(async trx => {
            const session = await authorize(token, undefined, trx, true);
            const current = await trx('checkout_requisicoes').where({ id: session.requisicao_atual, sessao_hash: session.token_hash }).first();
            if (!current?.pedido_id) return;
            const order = await trx('pedidos').where({ id: current.pedido_id }).first();
            if (order.fluxo_pagamento === 'INFINITEPAY' && !await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id', order.id).first('pedidos.id')) throw financialHttpError(409);
            const id = randomUUID();
            await trx('checkout_requisicoes').insert({ id, sessao_hash: session.token_hash });
            await trx('checkout_sessoes').where({ token_hash: session.token_hash }).update({ requisicao_atual: id });
        });
        return open(token);
    }
    return { open, authorize, lockCreation, attach, lookup, lookupOrder, lookupStatus, resume, newRequest };
}
