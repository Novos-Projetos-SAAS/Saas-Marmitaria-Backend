import { createHash } from 'node:crypto';
import { createInfinitepayCheckClient, normalizedPayment } from '../services/infinitepayCheckClient.js';
import { decryptApiKey } from '../utils/infinitepayCredentials.js';
import { decryptH1Observation, encryptH1Observation } from './infinitepayH1.js';
import { validateH1CheckoutUrl } from './infinitepayH1SingleLink.js';

const endpoint = 'https://api.checkout.infinitepay.io/payment_check';
const reservationKey = 'h2:payment-check:dispatch-reservation', responseKey = 'h2:payment-check:response';
const receiptOrigin = 'https://recibo.infinitepay.io';
const digest = value => createHash('sha256').update(value).digest('hex');
function refuse(code = 'H2_EVIDENCE_INCONSISTENT') {
    throw Object.assign(new Error('Verificação H2 bloqueada; consulte a evidência sem repetir o envio.'), { code });
}
function identifier(value, limit = 255) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > limit || /[\p{Cc}\p{Cf}]/u.test(value)) refuse();
    return value;
}
function objectJson(value) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') refuse();
        return parsed;
    } catch { refuse('H2_EVIDENCE_INVALID_JSON'); }
}
function receipt(value) {
    if (typeof value !== 'string' || !value.startsWith(receiptOrigin + '/') || /[\s\p{C}\\#]/u.test(value) ||
        /%(?![a-f0-9]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) refuse();
    const url = new URL(value);
    if (url.origin !== receiptOrigin || url.username || url.password) refuse();
    return value;
}

async function context(db, captureKey, lock = false) {
    const marker = await db('pagamentos_eventos').where({ event_key: 'h1:links:command-reservation' }).first();
    if (!marker?.pagamento_id || !await db('pagamentos_eventos').where({ event_key: 'h1:links:dispatch-budget' }).first('id')) refuse();
    const query = db('pagamentos').where({ id: marker.pagamento_id });
    const payment = await (lock ? query.forUpdate() : query).first();
    if (!payment) refuse();
    const orderQuery = db('pedidos').where({ id: payment.pedido_id });
    const order = await (lock ? orderQuery.forUpdate() : orderQuery).first();
    const config = await db('config_infinitepay').where({ id: 1 }).first();
    if (payment.status !== 'INCERTA' || payment.bloqueia_nova_cobranca !== true || String(payment.valor_centavos) !== '100' ||
        order?.fluxo_pagamento !== 'INFINITEPAY' || order.valor_total !== '1.00' || order.liberado_cozinha_em !== null ||
        config?.ativo !== false || config.handle !== 'matheuszxp' || payment.handle_snapshot !== 'matheuszxp') refuse();
    const items = await db('itens_pedido').where({ pedido_id: order.id });
    if (items.length !== 1 || items[0].quantidade !== 1 || items[0].preco_unitario !== '1.00' || items[0].subtotal !== '1.00') refuse();
    const originalBody = decryptH1Observation(marker.payload_filtrado, captureKey).body;
    const original = objectJson(originalBody);
    if (original.order_nsu !== payment.order_nsu || original.items?.length !== 1 || original.items[0].price !== 100 || original.items[0].quantity !== 1 ||
        digest(new URL(original.redirect_url).searchParams.get('r') || '') !== payment.return_nonce_hash) refuse();
    const links = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_LINKS' });
    if (links.length !== 1) refuse();
    const link = decryptH1Observation(links[0].payload_filtrado, captureKey);
    if (link.status !== 200) refuse();
    validateH1CheckoutUrl(objectJson(link.body));
    const rows = await db('pagamentos_eventos').whereIn('id', [26, 27, 28, 29]).orderBy('id');
    if (rows.length !== 4 || rows.some((row, i) => Number(row.id) !== 26 + i || row.tipo_evento !== (i < 3 ? 'H1_OBSERVACAO_WEBHOOK' : 'H1_OBSERVACAO_RETURN'))) refuse();
    const observed = rows.map(row => decryptH1Observation(row.payload_filtrado, captureKey));
    const bodies = observed.map(row => objectJson(row.body));
    const [created, settled, paid, returned] = bodies;
    if (created.event_type !== 'created' || settled.event_type !== 'settled' || paid.event_type !== 'paid' ||
        bodies.some(body => identifier(body.order_nsu, 120) !== payment.order_nsu) ||
        bodies.slice(0, 3).some(body => identifier(body.invoice_slug) !== identifier(returned.slug) || body.amount !== 100) ||
        identifier(paid.transaction_nsu) !== identifier(returned.transaction_nsu) ||
        bodies.slice(0, 3).some(body => body.transaction_nsu !== undefined && identifier(body.transaction_nsu) !== paid.transaction_nsu) ||
        digest(identifier(returned.r)) !== payment.return_nonce_hash || !/^[A-Za-z0-9_-]{43}$/.test(returned.r) ||
        receipt(paid.receipt_url) !== receipt(returned.receipt_url) ||
        !['pix', 'credit_card'].includes(paid.capture_method) || paid.capture_method !== returned.capture_method ||
        !Number.isSafeInteger(paid.paid_amount) || paid.paid_amount < 0 || !Number.isInteger(paid.installments) || paid.installments < 1 || paid.installments > 32767) refuse();
    const credential = await db('infinitepay_credenciais').where({ id: payment.credencial_id, handle: payment.handle_snapshot }).first();
    if (!credential) refuse();
    const outbox = Number((await db('outbox_eventos').count('* as n').first()).n);
    if (outbox !== 0 || Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n) !== 0) refuse();
    return { payment, paid, credential, request: { handle: payment.handle_snapshot, order_nsu: payment.order_nsu,
        transaction_nsu: paid.transaction_nsu, slug: paid.invoice_slug },
        evidenceHash: digest(JSON.stringify([originalBody, link.body, ...observed.map((row, i) => [rows[i].id, row.body])])),
        summary: { ready: true, read_only: true, identifiers_consistent: true, return_nonce_matches: true,
            receipt_consistent_between_events: true, observed_events: ['created', 'settled', 'paid', 'RETURN'],
            amount_expected_centavos: 100, observed_paid_amount_centavos: paid.paid_amount,
            observed_capture_method: paid.capture_method, observed_installments: paid.installments,
            attempt_status: payment.status, financial_confirmation: false, kitchen_released: false, outbox } };
}

export async function inspectH2Check({ db, captureKey }) {
    return db.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return (await context(trx, captureKey)).summary;
    });
}

function parseCheck(data, ctx) {
    if (!data || Array.isArray(data) || typeof data !== 'object') refuse('H2_RESPONSE_CONTRACT_INVALID');
    if (Object.hasOwn(data, 'success') && data.success !== true) refuse('H2_SUCCESS_NOT_TRUE');
    for (const [name, expected] of [['order_nsu', ctx.request.order_nsu], ['transaction_nsu', ctx.request.transaction_nsu],
        ['slug', ctx.request.slug], ['invoice_slug', ctx.request.slug]]) {
        if (Object.hasOwn(data, name)) {
            try { if (identifier(data[name]) !== expected) refuse(); } catch { refuse('H2_RESPONSE_IDENTIFIERS_MISMATCH'); }
        }
    }
    if (Object.hasOwn(data, 'receipt_url')) {
        try { if (receipt(data.receipt_url) !== ctx.paid.receipt_url) refuse(); } catch { refuse('H2_RESPONSE_RECEIPT_MISMATCH'); }
    }
    return { paid: data.paid, amount: data.amount, paidAmount: data.paid_amount, installments: data.installments,
        captureMethod: data.capture_method, ...(Object.hasOwn(data, 'receipt_url') ? { receiptUrl: data.receipt_url } : {}) };
}

export async function readH2CheckResult({ db, captureKey }) {
    return db.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const ctx = await context(trx, captureKey);
        const marker = await trx('pagamentos_eventos').where({ event_key: reservationKey }).first();
        const capture = await trx('pagamentos_eventos').where({ event_key: responseKey }).first();
        const result = { reserved: Boolean(marker), response_received: Boolean(capture), observation_only: true,
            payment_confirmed: false, attempt_status: ctx.payment.status, amount_expected_centavos: 100,
            identifiers_consistent: true, receipt_consistent_between_events: true,
            operational_transition_applied: false, kitchen_released: false, outbox: 0, automatic_retry: false };
        if (!capture) return { ...result, block_reason: 'H2_RESPONSE_NOT_CAPTURED' };
        const request = marker && decryptH1Observation(marker.payload_filtrado, captureKey);
        const observed = decryptH1Observation(capture.payload_filtrado, captureKey);
        if (marker?.pagamento_id !== ctx.payment.id || capture.pagamento_id !== ctx.payment.id ||
            JSON.stringify(request.request) !== JSON.stringify(ctx.request) || request.evidence_sha256 !== ctx.evidenceHash ||
            observed.request_sha256 !== digest(JSON.stringify(ctx.request))) refuse('H2_RESPONSE_BINDING_MISMATCH');
        result.http_status = observed.status;
        if (observed.status !== 200) return { ...result, block_reason: 'H2_HTTP_NOT_OK' };
        let data;
        try { data = JSON.parse(observed.body); } catch { return { ...result, block_reason: 'H2_RESPONSE_NOT_JSON' }; }
        const apiKey = decryptApiKey(ctx.credential, ctx.payment.handle_snapshot);
        result.response_fields = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).map(name =>
            /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(name) && !/api.?key|password|secret|token|authorization/i.test(name) &&
            !name.toLowerCase().includes(apiKey.toLowerCase()) ? name : '[PRIVATE_FIELD]') : [];
        if (typeof data?.success === 'boolean') result.success = data.success;
        if (typeof data?.paid === 'boolean') result.paid = data.paid;
        try {
            const proof = normalizedPayment(parseCheck(data, ctx), { orderNsu: ctx.request.order_nsu,
                transactionNsu: ctx.request.transaction_nsu, invoiceSlug: ctx.request.slug }, new Set([receiptOrigin]));
            Object.assign(result, { amount_centavos: proof.amount, paid_amount_centavos: proof.paidAmount,
                installments: proof.installments, capture_method: proof.captureMethod,
                paid_amount_matches_webhook: proof.paidAmount === ctx.paid.paid_amount,
                response_echoed_identifiers: ['order_nsu', 'transaction_nsu', 'slug', 'invoice_slug'].some(name => Object.hasOwn(data, name)),
                receipt_confirmed_by_payment_check: Object.hasOwn(data, 'receipt_url') });
            if (!proof.paid) refuse('H2_PAYMENT_NOT_CONFIRMED');
            if (proof.amount !== 100) refuse('H2_AMOUNT_MISMATCH');
            if (proof.captureMethod !== ctx.paid.capture_method) refuse('H2_METHOD_MISMATCH');
            result.payment_confirmed = true;
        } catch (error) { result.block_reason = /^H2_[A-Z_]+$/.test(error.code || '') ? error.code : 'H2_RESPONSE_CONTRACT_INVALID'; }
        return result;
    });
}

export async function executeH2Check({ db, captureKey, apiKey, transport, timeoutMs = 5000 }) {
    if (typeof transport !== 'function' || typeof apiKey !== 'string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) refuse('H2_NOT_CONFIGURED');
    const ctx = await db.transaction(async trx => {
        await trx.raw('SET LOCAL synchronous_commit = on');
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [reservationKey]);
        if (await trx('pagamentos_eventos').where({ event_key: reservationKey }).first('id')) return null;
        const current = await context(trx, captureKey, true);
        if (decryptApiKey(current.credential, current.payment.handle_snapshot) !== apiKey) refuse('H2_CREDENTIAL_MISMATCH');
        await trx('pagamentos_eventos').insert({ event_key: reservationKey, tipo_evento: 'H2_RESERVA_PAYMENT_CHECK',
            pagamento_id: current.payment.id, status_processamento: 'PENDENTE_IDENTIFICACAO',
            payload_filtrado: encryptH1Observation({ request: current.request, evidence_sha256: current.evidenceHash }, captureKey) });
        return current;
    });
    if (!ctx) return { ...await readH2CheckResult({ db, captureKey }), already_reserved: true };
    let sent = false;
    const client = createInfinitepayCheckClient({ timeoutMs, receiptOrigins: [receiptOrigin], parsePaymentCheck: data => parseCheck(data, ctx),
        transport: async (url, init) => {
            if (sent || url !== endpoint || init.method !== 'POST' || init.redirect !== 'error' ||
                init.body !== JSON.stringify(ctx.request) || init.headers['X-Api-Key'] !== apiKey) refuse('H2_TRANSPORT_BLOCKED');
            sent = true;
            const response = await transport(url, init), chunks = [];
            let size = 0;
            if (response.body) for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 65536 || init.signal.aborted) refuse('H2_RESPONSE_TOO_LARGE_OR_ABORTED');
                chunks.push(Buffer.from(chunk));
            }
            if (init.signal.aborted) refuse('H2_RESPONSE_ABORTED');
            const body = Buffer.concat(chunks).toString('utf8');
            const headers = Object.fromEntries([...response.headers].filter(([name]) => !/auth|cookie|token|key|secret|credential/i.test(name)));
            await db.transaction(async trx => {
                await trx.raw('SET LOCAL synchronous_commit = on');
                await trx.raw('SET LOCAL statement_timeout = 5000');
                await trx('pagamentos_eventos').insert({ event_key: responseKey, tipo_evento: 'H2_OBSERVACAO_PAYMENT_CHECK',
                    pagamento_id: ctx.payment.id, status_processamento: 'PENDENTE_IDENTIFICACAO',
                    payload_filtrado: encryptH1Observation({ status: response.status, headers, body,
                        request_sha256: digest(init.body) }, captureKey) });
            });
            return new Response(body, { status: response.status });
        } });
    // H2 never invokes the event processor or changes the financial/operational state.
    try { await client.checkPayment({ apiKey, handle: ctx.request.handle, orderNsu: ctx.request.order_nsu,
        transactionNsu: ctx.request.transaction_nsu, invoiceSlug: ctx.request.slug }); } catch { /* Reservation remains consumed. */ }
    return readH2CheckResult({ db, captureKey });
}
