import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadH2CheckEvidence } from './infinitepayH2Check.js';
import { encryptH1Observation, decryptH1Observation } from './infinitepayH1.js';
import { decryptApiKey } from '../utils/infinitepayCredentials.js';
import { snapshot } from '../services/paymentOrchestrator.js';
import { parseObservedInfinitepayEvent } from '../services/infinitepayObservedContracts.js';
import { createInfinitepayEventsService } from '../services/infinitepayEventsService.js';
import { createPaymentOutboxService } from '../services/paymentOutboxService.js';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';

const doneKey = 'h3:reconciliation:done', consumerPrefix = 'h3:consumer:';
const maxAge = 24 * 3600000, receiptOrigin = 'https://recibo.infinitepay.io';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function refuse(code = 'H3_EVIDENCE_INVALID') {
    throw Object.assign(new Error('Homologação H3 bloqueada; consulte o status sem repetir APIs financeiras.'), { code });
}
function receiptUrl(ctx) {
    const value = ctx.paid.receipt_url, url = new URL(value);
    if (url.origin !== receiptOrigin || url.username || url.password || url.search || url.hash || /[\s\p{C}\\]/u.test(value) ||
        /%(?:2f|5c|2e|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) || url.href !== value ||
        !url.pathname.split('/').some(segment => segment === ctx.request.transaction_nsu)) refuse('H3_RECEIPT_NOT_BOUND');
    return value;
}

async function evidence(db, captureKey) {
    const bundle = await loadH2CheckEvidence({ db, captureKey, allowReconciled: true });
    if (!bundle.result.payment_confirmed || !bundle.proof?.paid) refuse('H3_INDEPENDENT_PROOF_REQUIRED');
    const ctx = bundle.context;
    const method = await db('metodos_pagamento').where({ id: ctx.order.metodo_pagamento_id }).first();
    const items = await db('itens_pedido').where({ pedido_id: ctx.order.id }).orderBy('id');
    const composition = await db('composicao_item_pedido').whereIn('item_pedido_id', items.map(item => item.id)).orderBy('item_pedido_id').orderBy('alimento_id');
    if (!method || snapshot(ctx.order, items, composition, method).payloadHash !== ctx.order.client_payload_hash) refuse('H3_SNAPSHOT_MISMATCH');
    const url = receiptUrl(ctx);
    const fingerprint = digest([ctx.evidenceHash, bundle.capture.id, bundle.capture.recebido_em, bundle.capture.payload_filtrado,
        bundle.marker.payload_filtrado, ctx.credential]);
    return { ...bundle, url, fingerprint };
}

function fresh(bundle, instant) {
    const received = new Date(bundle.capture.recebido_em).getTime(), reserved = new Date(bundle.marker.recebido_em).getTime();
    const age = instant.getTime() - received;
    if (!Number.isFinite(age) || age < 0 || age > maxAge || !Number.isFinite(reserved) || received < reserved || received - reserved > 30000) {
        refuse('H3_EVIDENCE_EXPIRED_OR_FUTURE');
    }
}
async function validateFresh(db, bundle, captureKey, instant) {
    fresh(bundle, instant);
    const original = await db('pagamentos_eventos').whereIn('id', [26, 27, 28]);
    const knownBodies = new Set(original.map(row => decryptH1Observation(row.payload_filtrado, captureKey).body));
    const later = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_WEBHOOK' })
        .where('recebido_em', '>', bundle.capture.recebido_em);
    for (const row of later) {
        try {
            const observed = decryptH1Observation(row.payload_filtrado, captureKey);
            if (knownBodies.has(observed.body)) continue;
            const body = JSON.parse(observed.body), ids = bundle.context.request;
            const validId = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
            if (!body || !validId(body.order_nsu) ||
                ['invoice_slug', 'slug', 'transaction_nsu'].some(field => Object.hasOwn(body, field) && !validId(body[field])) ||
                body.order_nsu === ids.order_nsu || body.invoice_slug === ids.slug || body.slug === ids.slug ||
                body.transaction_nsu === ids.transaction_nsu) refuse();
        } catch { refuse('H3_NEW_PROVIDER_EVIDENCE_REQUIRES_REVIEW'); }
    }
}
function credential(bundle, apiKey) {
    if (typeof apiKey !== 'string' || decryptApiKey(bundle.context.credential, bundle.context.payment.handle_snapshot) !== apiKey) refuse('H3_CREDENTIAL_MISMATCH');
}
async function checkReceipt(url, transport) {
    if (typeof transport !== 'function') refuse('H3_RECEIPT_CHECK_REQUIRED');
    const controller = new AbortController(); let timer;
    try {
        const response = await Promise.race([transport(url, { method: 'HEAD', redirect: 'error', signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 5000); })]);
        if (response.status !== 200 || response.redirected || response.headers.has('location')) refuse();
    } catch { refuse('H3_RECEIPT_HTTP_CHECK_FAILED'); }
    finally { clearTimeout(timer); }
}

async function status(db, bundle, captureKey) {
    const { context: ctx } = bundle;
    const marker = await db('pagamentos_eventos').where({ event_key: doneKey }).first();
    const rows = await db('outbox_eventos').where({ pedido_id: ctx.payment.pedido_id });
    let applied = false;
    if (marker) {
        const saved = decryptH1Observation(marker.payload_filtrado, captureKey), payment = ctx.payment;
        applied = marker.pagamento_id === payment.id && saved.fingerprint === bundle.fingerprint && payment.status === 'PAGA' &&
            payment.transaction_nsu === ctx.request.transaction_nsu && payment.invoice_slug === ctx.request.slug && payment.receipt_url === bundle.url &&
            String(payment.valor_base_provider_centavos) === String(bundle.proof.amount) && String(payment.valor_pago_provider_centavos) === String(bundle.proof.paidAmount) &&
            payment.capture_method === bundle.proof.captureMethod && payment.installments === bundle.proof.installments &&
            Boolean(payment.provider_verified_at && payment.pago_em && ctx.order.liberado_cozinha_em) && rows.length === 1 &&
            rows[0].tipo === 'PEDIDO_LIBERADO' && rows[0].chave_unica === 'pedido_liberado:' + payment.pedido_id;
        if (!applied) refuse('H3_RECONCILIATION_STATE_INCONSISTENT');
    } else if (ctx.payment.status !== 'INCERTA' || rows.length) refuse('H3_STATE_WITHOUT_RECONCILIATION');
    const effect = rows[0] && await db('pagamentos_eventos').where({ event_key: consumerPrefix + rows[0].chave_unica }).first('id');
    return { payment_status: ctx.payment.status, already_reconciled: applied, amount_centavos: bundle.proof.amount,
        paid_amount_centavos: bundle.proof.paidAmount, capture_method: bundle.proof.captureMethod, installments: bundle.proof.installments,
        kitchen_logically_released: Boolean(ctx.order.liberado_cozinha_em), outbox_count: rows.length, outbox_status: rows[0]?.status ?? null,
        consumer_effects: effect ? 1 : 0, physical_delivery: false, checkout_enabled: false };
}

export async function readH3Status({ db, captureKey }) {
    return db.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return status(trx, await evidence(trx, captureKey), captureKey);
    });
}

export async function previewH3({ db, captureKey, apiKey, receiptTransport, now = () => new Date() }) {
    const loaded = await db.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const bundle = await evidence(trx, captureKey), current = await status(trx, bundle, captureKey);
        if (!current.already_reconciled) { await validateFresh(trx, bundle, captureKey, now()); credential(bundle, apiKey); }
        return { bundle, current };
    });
    if (!loaded.current.already_reconciled) await checkReceipt(loaded.bundle.url, receiptTransport);
    return { fingerprint: loaded.bundle.fingerprint, summary: { ...loaded.current, ready: !loaded.current.already_reconciled,
        evidence_max_age_hours: 24, evidence_captured_at: loaded.bundle.capture.recebido_em,
        evidence_expires_at: new Date(new Date(loaded.bundle.capture.recebido_em).getTime() + maxAge),
        receipt_https_checked: !loaded.current.already_reconciled,
        changes: loaded.current.already_reconciled ? [] : ['INCERTA -> PAGA', 'liberação lógica do pedido', 'uma outbox PEDIDO_LIBERADO'] } };
}

export async function confirmH3({ input = process.stdin, output = process.stdout } = {}) {
    if (input.isTTY !== true || output.isTTY !== true) refuse('H3_INTERACTIVE_CONFIRMATION_REQUIRED');
    const terminal = createInterface({ input, output, terminal: false });
    try { return await terminal.question('Digite exatamente CONFIRMAR H3 100 CENTAVOS para reconciliar e liberar logicamente apenas a H1: ') === 'CONFIRMAR H3 100 CENTAVOS'; }
    finally { terminal.close(); }
}

export async function reconcileH3({ db, captureKey, apiKey, expectedFingerprint, receiptTransport, now = () => new Date() }) {
    const preview = await previewH3({ db, captureKey, apiKey, receiptTransport, now });
    if (preview.summary.already_reconciled) return readH3Status({ db, captureKey });
    if (expectedFingerprint !== preview.fingerprint) refuse('H3_APPROVAL_CONTEXT_CHANGED');
    return db.transaction(async trx => {
        await trx.raw('SET LOCAL synchronous_commit = on');
        await trx.raw('SET LOCAL lock_timeout = 5000');
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [doneKey]);
        // H1 observation writers use this table too; serialize them until this isolated reconciliation commits.
        await trx.raw('LOCK TABLE pagamentos_eventos IN SHARE ROW EXCLUSIVE MODE');
        let bundle = await evidence(trx, captureKey);
        if ((await status(trx, bundle, captureKey)).already_reconciled) return status(trx, bundle, captureKey);
        // Match the financial processor's identity -> order -> payment lock order.
        for (const key of ['invoice:' + bundle.context.request.slug, 'transaction:' + bundle.context.request.transaction_nsu].sort()) {
            await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify(['infinitepay', bundle.context.request.handle, key])]);
        }
        await trx('pedidos').where({ id: bundle.context.payment.pedido_id }).forUpdate().first('id');
        await trx('pagamentos').where({ id: bundle.context.payment.id }).forUpdate().first('id');
        await trx('metodos_pagamento').where({ id: bundle.context.order.metodo_pagamento_id }).forShare().first('id');
        const lockedItems = await trx('itens_pedido').where({ pedido_id: bundle.context.payment.pedido_id }).orderBy('id').forUpdate().select('id');
        await trx('composicao_item_pedido').whereIn('item_pedido_id', lockedItems.map(item => item.id))
            .orderBy('item_pedido_id').orderBy('alimento_id').forUpdate();
        bundle = await evidence(trx, captureKey);
        const instant = now(); await validateFresh(trx, bundle, captureKey, instant); credential(bundle, apiKey);
        if (bundle.fingerprint !== expectedFingerprint) refuse('H3_APPROVAL_CONTEXT_CHANGED');
        const ctx = bundle.context;
        const processor = createInfinitepayEventsService({ db: trx, parseEvent: parseObservedInfinitepayEvent, receiptOrigins: [receiptOrigin],
            now: () => new Date(instant), client: { async checkPayment(request) {
                if (request.apiKey !== apiKey || request.handle !== ctx.request.handle || request.orderNsu !== ctx.request.order_nsu ||
                    request.transactionNsu !== ctx.request.transaction_nsu || request.invoiceSlug !== ctx.request.slug) refuse('H3_RECORDED_REQUEST_MISMATCH');
                // This is authenticated H2 evidence, not a new provider response or a webhook proof.
                return { ...bundle.proof, receiptUrl: bundle.url };
            } } });
        const received = await processor.receive(ctx.paid);
        const processed = await processor.processEvent(received.eventId);
        if (processed?.status !== 'CONCLUIDO') refuse('H3_FINANCIAL_TRANSACTION_REJECTED');
        await validateFresh(trx, bundle, captureKey, now());
        await trx('pagamentos_eventos').insert({ event_key: doneKey, tipo_evento: 'H3_RECONCILIACAO', pagamento_id: ctx.payment.id,
            status_processamento: 'CONCLUIDO', processado_em: instant,
            payload_filtrado: encryptH1Observation({ fingerprint: bundle.fingerprint, evidence_max_age_hours: 24,
                source_event_ids: [26, 27, 28, 29], check_response_event_id: bundle.capture.id,
                receipt_sources: ['WEBHOOK_28', 'RETURN_29'], applied_at: instant }, captureKey) });
        return status(trx, await evidence(trx, captureKey), captureKey);
    });
}

export function createH3Consumer({ db, pedidoId, pagamentoId }) {
    return async dto => db.transaction(async trx => {
        await trx.raw('SET LOCAL synchronous_commit = on');
        const row = await trx('outbox_eventos').where({ id: dto.id, pedido_id: pedidoId, tipo: 'PEDIDO_LIBERADO', chave_unica: 'pedido_liberado:' + pedidoId }).first();
        if (!row || dto.pedidoId !== pedidoId || dto.tipo !== row.tipo || dto.key !== row.chave_unica ||
            String(row.payload_reduzido.pagamento_id) !== String(pagamentoId) ||
            !await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id', pedidoId).first('pedidos.id')) refuse('H3_CONSUMER_SCOPE_INVALID');
        // The unique durable receipt IS the isolated logical effect; no physical delivery occurs.
        await trx('pagamentos_eventos').insert({ event_key: consumerPrefix + row.chave_unica, tipo_evento: 'H3_CONSUMO_ISOLADO',
            pagamento_id: pagamentoId, status_processamento: 'CONCLUIDO', processado_em: trx.fn.now(),
            payload_filtrado: { version: 1, outbox_id: row.id, logical_effect: 'PEDIDO_RECEBIDO_HOMOLOGACAO' } }).onConflict('event_key').ignore();
    });
}

export async function deliverH3({ db, captureKey }) {
    const loaded = await db.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const bundle = await evidence(trx, captureKey);
        if (!(await status(trx, bundle, captureKey)).already_reconciled) refuse('H3_RECONCILIATION_REQUIRED');
        const row = await trx('outbox_eventos').where({ pedido_id: bundle.context.payment.pedido_id, tipo: 'PEDIDO_LIBERADO' }).first('id');
        return { row, payment: bundle.context.payment };
    });
    const worker = createPaymentOutboxService({ db, deliver: createH3Consumer({ db, pedidoId: loaded.payment.pedido_id, pagamentoId: loaded.payment.id }) });
    await worker.processEvent(loaded.row.id);
    return readH3Status({ db, captureKey });
}
