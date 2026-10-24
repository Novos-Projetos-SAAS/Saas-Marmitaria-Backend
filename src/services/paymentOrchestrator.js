import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decryptApiKey } from '../utils/infinitepayCredentials.js';
import { buildCheckoutPayload, checkoutValidUntil, InfinitepayClientError } from './infinitepayClient.js';
import { metodoPermiteInfinitepay } from '../utils/pedidoPaymentPolicy.js';

class PaymentPreparationError extends Error {
    constructor(code, statusCode = 409) {
        super('Não foi possível preparar esta tentativa financeira.');
        this.name = 'PaymentPreparationError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
function refuse(code, status) { throw new PaymentPreparationError(code, status); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function cents(value) {
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) refuse('INVALID_ORDER_AMOUNT');
    const result = Number(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
    if (!Number.isSafeInteger(result)) refuse('INVALID_ORDER_AMOUNT');
    return result;
}
function attemptDto(row) {
    return { pedidoId: row.pedido_id, attemptId: row.id, status: row.status, orderNsu: row.order_nsu,
        validUntil: new Date(row.valid_until).toISOString(),
        ...(row.status === 'AGUARDANDO' && row.checkout_url ? { checkoutUrl: row.checkout_url } : {}) };
}
function safeUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
        return url;
    } catch { refuse('INVALID_CHECKOUT_URL', 400); }
}
export function snapshot(order, items, composition, method) {
    if (!items.length) refuse('INVALID_ORDER_AMOUNT');
    let total = 0;
    for (const item of items) {
        const price = cents(item.preco_unitario);
        const subtotal = cents(item.subtotal);
        if (!Number.isSafeInteger(item.quantidade) || item.quantidade < 1 || price < 1 ||
            !Number.isSafeInteger(price * item.quantidade) || subtotal !== price * item.quantidade) refuse('INVALID_ORDER_AMOUNT');
        total += subtotal;
    }
    if (!Number.isSafeInteger(total) || total < 1 || total !== cents(order.valor_total)) refuse('INVALID_ORDER_AMOUNT');
    const content = { version: 1, pedidoId: order.id, nome: order.nome_cliente, telefone: order.telefone_cliente,
        endereco: order.endereco_cliente, entrega: order.metodo_entrega, observacoes: order.observacoes,
        metodo: [method.id, method.codigo, method.tipo_financeiro], total,
        items: items.map(item => [item.id, item.tamanho_marmita_id, item.produto_id, item.marmita_especial_id,
            item.quantidade, cents(item.preco_unitario), cents(item.subtotal), item.nome_item_snapshot, item.descricao_item_snapshot, item.observacao]),
        composition: composition.map(item => [item.item_pedido_id, item.alimento_id]) };
    return { total, payloadHash: hash(JSON.stringify(content)) };
}

export function createPaymentOrchestrator({ db, client, redirectUrl, webhookUrl, now = () => new Date(), orderNsuPrefix = 'PED' } = {}) {
    if (!db || typeof db.transaction !== 'function' || typeof client?.createCheckout !== 'function' || typeof now !== 'function' ||
        typeof orderNsuPrefix !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(orderNsuPrefix)) {
        refuse('PREPARATION_BLOCKED', 503);
    }
    const returnBase = safeUrl(redirectUrl);
    const webhook = safeUrl(webhookUrl);
    if (returnBase.searchParams.has('r')) refuse('INVALID_CHECKOUT_URL', 400);

    async function reserveInTransaction(input, trx) {
        validateInput(input);
        const pedidoId = input.pedidoId, requestId = input.clientRequestId.toLowerCase();
        const order = await trx('pedidos').where({ id: pedidoId }).whereNull('deletado_em').forUpdate().first();
        if (!order) refuse('ORDER_NOT_FOUND', 404);
        if (order.fluxo_pagamento !== 'INFINITEPAY') refuse('POSTERIOR_ORDER');
        const method = await trx('metodos_pagamento').where({ id: order.metodo_pagamento_id, ativo: true }).whereNull('deletado_em').first();
        if (!metodoPermiteInfinitepay(method)) refuse('PAYMENT_METHOD_NOT_MAPPED');
        const items = await trx('itens_pedido').where({ pedido_id: pedidoId }).orderBy('id').forShare();
        const composition = await trx('composicao_item_pedido').whereIn('item_pedido_id', items.map(item => item.id))
            .orderBy('item_pedido_id').orderBy('alimento_id').forShare();
        const trusted = snapshot(order, items, composition, method);
        const previous = await trx('pagamentos').where({ pedido_id: pedidoId }).orderBy('tentativa_numero', 'desc').forUpdate();
        if (order.client_request_id !== null) {
            if (order.client_request_id !== requestId || order.client_payload_hash !== trusted.payloadHash || !previous.length) refuse('IDEMPOTENCY_CONFLICT');
            const paid = previous.find(row => ['PAGA', 'LIQUIDADA', 'ESTORNADA'].includes(row.status));
            return { created: false, attempt: paid || previous[0] };
        }
        if (previous.length || order.liberado_cozinha_em !== null || order.status !== 'Pendente') refuse('EXISTING_FINANCIAL_STATE');
        const config = await trx('config_infinitepay').where({ id: 1 }).forShare().first();
        const credential = config?.credencial_atual_id && await trx('infinitepay_credenciais')
            .where({ id: config.credencial_atual_id, config_id: 1, handle: config.handle }).first();
        if (!credential) refuse('CREDENTIAL_UNAVAILABLE', 503);
        const instant = now();
        const validUntil = checkoutValidUntil(instant);
        const nonce = randomBytes(32).toString('base64url');
        const returnUrl = new URL(returnBase);
        returnUrl.searchParams.set('r', nonce);
        const orderNsu = orderNsuPrefix + '-' + pedidoId + '-T1-' + randomUUID();
        const customer = {};
        if (typeof order.nome_cliente === 'string' && order.nome_cliente.trim()) customer.name = order.nome_cliente.trim();
        if (typeof order.telefone_cliente === 'string' && /^\+[1-9]\d{7,14}$/.test(order.telefone_cliente)) customer.phone_number = order.telefone_cliente;
        const payload = buildCheckoutPayload({ orderNsu,
            items: [{ quantity: 1, price: trusted.total, description: 'Pedido #' + pedidoId + ' — Marmitas e complementos' }],
            validUntil, redirectUrl: returnUrl.toString(), webhookUrl: webhook.toString(),
            assuredInstallments: config.assured_installments, customer: Object.keys(customer).length ? customer : undefined, now: instant });
        await trx('pedidos').where({ id: pedidoId }).update({ client_request_id: requestId, client_payload_hash: trusted.payloadHash });
        const [attempt] = await trx('pagamentos').insert({ pedido_id: pedidoId, tentativa_numero: 1,
            order_nsu: orderNsu, status: 'CRIANDO', bloqueia_nova_cobranca: true,
            credencial_id: credential.id, handle_snapshot: credential.handle, valor_centavos: trusted.total,
            valid_until: validUntil, return_nonce_hash: hash(nonce) }).returning('*');
        return { created: true, attempt, credential, payload };
    }

    async function persistOutcome(attempt, outcome, result) {
        try {
            return await db.transaction(async trx => {
                await trx('pedidos').where({ id: attempt.pedido_id }).forUpdate().first('id');
                const current = await trx('pagamentos').where({ id: attempt.id, pedido_id: attempt.pedido_id }).forUpdate().first();
                if (!current) refuse('RESERVATION_MISSING', 503);
                if (current.status !== 'CRIANDO') return attemptDto(current);
                const [saved] = await trx('pagamentos').where({ id: attempt.id, status: 'CRIANDO' }).update({
                    status: outcome, atualizado_em: trx.fn.now(),
                    ...(outcome === 'AGUARDANDO' ? { checkout_url: result.checkoutUrl, invoice_slug: result.invoiceSlug ?? null, error_code: null }
                        : { error_code: outcome === 'FALHOU' ? 'CHECKOUT_PREPARATION_FAILED' : 'CHECKOUT_RESULT_UNKNOWN' })
                }).returning('*');
                return attemptDto(saved);
            });
        } catch { refuse('CHECKOUT_PERSISTENCE_UNCERTAIN', 503); }
    }

    function validateInput(input) {
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['pedidoId', 'clientRequestId'].includes(key)) ||
            !Number.isSafeInteger(input.pedidoId) || input.pedidoId < 1 ||
            typeof input.clientRequestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.clientRequestId)) {
            refuse('INVALID_REQUEST_ID', 400);
        }
    }
    async function completeReservation(reservation) {
        if (!reservation.created) return attemptDto(reservation.attempt);
        // Only the transaction winner dispatches. Abandoned/uncertain reservations are never automatically reclaimed.
        let apiKey, sent = false, result, outcome = 'AGUARDANDO';
        try {
            apiKey = decryptApiKey(reservation.credential, reservation.attempt.handle_snapshot);
            sent = true;
            result = await client.createCheckout({ apiKey, payload: reservation.payload });
            safeUrl(result?.checkoutUrl);
            if (result.invoiceSlug !== undefined && (typeof result.invoiceSlug !== 'string' || !result.invoiceSlug.trim() || /[\r\n\0]/.test(result.invoiceSlug))) throw new Error();
        } catch (error) {
            outcome = !sent || (error instanceof InfinitepayClientError && error.outcome === 'FALHOU') ? 'FALHOU' : 'INCERTA';
        } finally { apiKey = undefined; }
        return persistOutcome(reservation.attempt, outcome, result);
    }
    return { reserveInTransaction, completeReservation, async prepareCheckout(input) {
        validateInput(input);
        let reservation;
        try { reservation = await db.transaction(trx => reserveInTransaction(input, trx)); }
        catch (error) {
            if (error instanceof PaymentPreparationError) throw error;
            if (error.code === '23505') refuse('IDEMPOTENCY_CONFLICT');
            refuse('RESERVATION_FAILED', 503);
        }
        return completeReservation(reservation);
    } };
}
