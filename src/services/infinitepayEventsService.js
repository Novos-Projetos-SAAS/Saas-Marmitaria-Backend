import { createHash, randomUUID } from 'node:crypto';
import { decryptApiKey } from '../utils/infinitepayCredentials.js';
import { receiptMatchesTransaction } from './infinitepayObservedContracts.js';

const eventTypes = new Set(['created', 'paid', 'settled', 'refunded', 'canceled', 'payment_failed']);
const confirmedStates = new Set(['PAGA', 'LIQUIDADA', 'ESTORNADA']);
class FinancialEventError extends Error {
    constructor(code, statusCode = 503) {
        super('Não foi possível processar o evento financeiro.');
        this.name = 'FinancialEventError'; this.code = code; this.statusCode = statusCode;
    }
}
function refuse(code, status) { throw new FinancialEventError(code, status); }
function identifier(value, limit, optional = false) {
    if (value === undefined || value === null) {
        if (optional) return undefined;
        refuse('INVALID_IDENTIFIER', 400);
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\p{Cc}\p{Cf}]/u.test(value)) refuse('INVALID_IDENTIFIER', 400);
    return value.trim();
}
function canonicalEvent(raw) {
    let nodes = 0;
    function visit(value, depth) {
        if (++nodes > 2000 || depth > 8) refuse('INVALID_EVENT', 400);
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.length <= 32768) return value;
        if (!value || typeof value !== 'object') refuse('INVALID_EVENT', 400);
        if (Array.isArray(value)) return Array.from(value, item => visit(item, depth + 1));
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse('INVALID_EVENT', 400);
        return Object.fromEntries(Object.keys(value).sort().map(key => {
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (!property || !Object.hasOwn(property, 'value')) refuse('INVALID_EVENT', 400);
            return [key, visit(property.value, depth + 1)];
        }));
    }
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') refuse('INVALID_EVENT', 400);
    const serialized = JSON.stringify(visit(raw, 0));
    if (Buffer.byteLength(serialized) > 32768) refuse('INVALID_EVENT', 400);
    return serialized;
}
function dto(row) {
    return { eventId: row.id, status: row.status_processamento, attempts: row.tentativas,
        ...(row.ultimo_erro ? { code: row.ultimo_erro } : {}) };
}
function outcome(status, code = null, paymentId = null) { return { status, code, paymentId }; }
function orderCents(value) {
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) return null;
    const result = Number(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
    return Number.isSafeInteger(result) && result > 0 ? result : null;
}
function safeReceipt(value, origins) {
    try {
        if (typeof value !== 'string' || value !== value.trim() || /[\p{Cc}\p{Cf}\\#]/u.test(value) || !/^https:\/\//i.test(value)) return null;
        const url = new URL(value);
        const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
        return url.protocol === 'https:' && !url.username && !url.password && !authority.includes('@') && origins.has(url.origin) ? url.href : null;
    } catch { return null; }
}

export function createInfinitepayEventsService({ db, client, parseEvent, receiptOrigins = [], now = () => new Date(),
    leaseMs = 30000, retryMs = 1000, maxAttempts = 5 } = {}) {
    if (typeof db !== 'function' || typeof db.transaction !== 'function' || typeof client?.checkPayment !== 'function' ||
        typeof parseEvent !== 'function' || typeof now !== 'function' || !Array.isArray(receiptOrigins) ||
        ![leaseMs, retryMs, maxAttempts].every(value => Number.isSafeInteger(value) && value > 0) ||
        leaseMs > 86400000 || retryMs > 86400000 || maxAttempts > 100) refuse('EVENT_PROCESSOR_NOT_CONFIGURED');
    const origins = new Set(receiptOrigins);
    function time() {
        const value = now();
        if (!(value instanceof Date) || !Number.isFinite(value.getTime())) refuse('INVALID_CLOCK');
        return value;
    }
    async function receive(raw, parser = parseEvent) {
        let filtered, key;
        try {
            const canonical = canonicalEvent(raw);
            const parsed = await parser(JSON.parse(canonical));
            if (!parsed || !eventTypes.has(parsed.type)) refuse('INVALID_EVENT', 400);
            const invoiceSlug = identifier(parsed.invoiceSlug, 255, true);
            const slug = identifier(parsed.slug, 255, true);
            if (invoiceSlug && slug && invoiceSlug !== slug) refuse('AMBIGUOUS_IDENTIFIER', 400);
            filtered = { version: 1, type: parsed.type,
                ...Object.fromEntries(Object.entries({ orderNsu: identifier(parsed.orderNsu, 120, true),
                    transactionNsu: identifier(parsed.transactionNsu, 255, true), invoiceSlug: invoiceSlug || slug,
                    receiptUrl: receiptMatchesTransaction(parsed.receiptUrl,parsed.transactionNsu,[...origins]) ? parsed.receiptUrl : undefined }).filter(([, value]) => value !== undefined)) };
            key = 'ip:event:v1:' + createHash('sha256').update(canonical).digest('hex');
        } catch (error) {
            if (error instanceof FinancialEventError) throw error;
            refuse('INVALID_EVENT', 400);
        }
        try {
            const [saved] = await db('pagamentos_eventos').insert({ event_key: key, tipo_evento: filtered.type,
                payload_filtrado: filtered, status_processamento: filtered.orderNsu ? 'PENDENTE' : 'PENDENTE_IDENTIFICACAO' })
                .onConflict('event_key').ignore().returning('*');
            return dto(saved || await db('pagamentos_eventos').where({ event_key: key }).first());
        } catch { refuse('EVENT_STORAGE_FAILED'); }
    }
    async function claim(eventId) {
        const instant = time();
        return db.transaction(async trx => {
            const row = await trx('pagamentos_eventos').where(function () {
                this.where(function () {
                    this.whereIn('status_processamento', ['PENDENTE', 'PENDENTE_IDENTIFICACAO', 'ERRO'])
                        .where('tentativas', '<', maxAttempts).where(function () {
                            this.whereNull('proxima_tentativa_em').orWhere('proxima_tentativa_em', '<=', instant);
                        });
                }).orWhere(function () {
                    this.where({ status_processamento: 'PROCESSANDO' }).where(function () {
                        this.whereNull('locked_until').orWhere('locked_until', '<=', instant);
                    });
                });
            }).modify(query => { if (eventId !== undefined) query.where({ id: eventId }); })
                .orderBy('recebido_em').orderBy('id').forUpdate().skipLocked().first();
            if (!row) return null;
            if (row.tentativas >= maxAttempts) {
                const [exhausted] = await trx('pagamentos_eventos').where({ id: row.id }).update({ status_processamento: 'ERRO',
                    locked_by: null, locked_until: null, proxima_tentativa_em: null, ultimo_erro: 'RECONCILIATION_REQUIRED' }).returning('*');
                return { ...exhausted, exhausted: true };
            }
            const [saved] = await trx('pagamentos_eventos').where({ id: row.id }).update({ status_processamento: 'PROCESSANDO',
                tentativas: row.tentativas + 1, locked_by: randomUUID(), locked_until: new Date(instant.getTime() + leaseMs),
                proxima_tentativa_em: null }).returning('*');
            return saved;
        });
    }
    function owned(query, event) {
        return query.where({ id: event.id, status_processamento: 'PROCESSANDO', locked_by: event.locked_by }).where('locked_until', '>', time());
    }
    function matchesStored(payment, ids) {
        return (!payment.transaction_nsu || identifier(payment.transaction_nsu, 255) === ids.transactionNsu) &&
            (!payment.invoice_slug || identifier(payment.invoice_slug, 255) === ids.invoiceSlug);
    }
    async function verify(event) {
        const signal = event.payload_filtrado;
        if (!signal?.orderNsu) return outcome('PENDENTE_IDENTIFICACAO', 'IDENTIFIERS_REQUIRED');
        const payment = await db('pagamentos').where({ order_nsu: signal.orderNsu, provedor: 'INFINITEPAY' }).first();
        if (!payment) return outcome('PENDENTE_IDENTIFICACAO', 'ATTEMPT_NOT_IDENTIFIED');
        const order = await db('pedidos').where({ id: payment.pedido_id }).whereNull('deletado_em').first();
        if (!order || order.fluxo_pagamento !== 'INFINITEPAY') return outcome('ERRO', 'ORDER_INELIGIBLE', payment.id);
        let ids;
        try {
            ids = { orderNsu: identifier(payment.order_nsu, 120), transactionNsu: identifier(signal.transactionNsu ?? payment.transaction_nsu, 255),
                invoiceSlug: identifier(signal.invoiceSlug ?? payment.invoice_slug, 255) };
            if (!matchesStored(payment, ids)) return outcome('ERRO', 'IDENTIFIER_CONFLICT', payment.id);
        } catch { return outcome('PENDENTE_IDENTIFICACAO', 'IDENTIFIERS_REQUIRED', payment.id); }
        const credential = await db('infinitepay_credenciais').where({ id: payment.credencial_id, handle: payment.handle_snapshot }).first();
        if (!credential) return outcome('PENDENTE', 'CREDENTIAL_UNAVAILABLE', payment.id);
        let proof;
        try {
            proof = await client.checkPayment({ apiKey: decryptApiKey(credential, payment.handle_snapshot), handle: payment.handle_snapshot, ...ids });
        } catch { return outcome('PENDENTE', 'PAYMENT_CHECK_UNAVAILABLE', payment.id); }
        if (!proof || typeof proof.paid !== 'boolean') return outcome('PENDENTE', 'PAYMENT_CHECK_INVALID', payment.id);
        if (proof.identifiers && Object.keys(ids).some(key => proof.identifiers[key] !== ids[key])) return outcome('ERRO', 'PROVIDER_IDENTIFIER_CONFLICT', payment.id);
        if (proof.paid && (!Number.isSafeInteger(proof.amount) || proof.amount < 1 || !Number.isSafeInteger(proof.paidAmount) || proof.paidAmount < 0 ||
            !Number.isInteger(proof.installments) || proof.installments < 1 || proof.installments > 32767 ||
            !['pix', 'credit_card'].includes(proof.captureMethod) ||
            (proof.financialState !== undefined && !confirmedStates.has(proof.financialState)))) return outcome('ERRO', 'PAYMENT_CHECK_INVALID', payment.id);

        return db.transaction(async trx => {
            // Serialize external identities across orders without assuming provider-wide cardinality in a migration.
            for (const key of ['invoice:' + ids.invoiceSlug, 'transaction:' + ids.transactionNsu].sort()) {
                await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify(['infinitepay', payment.handle_snapshot, key])]);
            }
            const lockedOrder = await trx('pedidos').where({ id: payment.pedido_id }).forUpdate().first();
            const current = await trx('pagamentos').where({ id: payment.id }).forUpdate().first();
            if (!await owned(trx('pagamentos_eventos'), event).forUpdate().first()) return outcome('PENDENTE', 'LEASE_LOST', payment.id);
            if (!lockedOrder || lockedOrder.deletado_em || lockedOrder.fluxo_pagamento !== 'INFINITEPAY' ||
                !current || current.pedido_id !== payment.pedido_id || current.order_nsu !== ids.orderNsu ||
                current.credencial_id !== payment.credencial_id || current.handle_snapshot !== payment.handle_snapshot ||
                current.valor_centavos !== payment.valor_centavos || lockedOrder.valor_total !== order.valor_total || !matchesStored(current, ids)) {
                return outcome('ERRO', 'CORRELATION_CHANGED', payment.id);
            }
            const instant = time();
            if (!proof.paid) {
                await trx('pagamentos').where({ id: current.id }).update({ last_checked_at: instant });
                return outcome('PENDENTE', 'PAYMENT_NOT_CONFIRMED', current.id);
            }
            const reused = await trx('pagamentos').where({ handle_snapshot: current.handle_snapshot }).whereNot({ id: current.id }).where(function () {
                this.where({ transaction_nsu: ids.transactionNsu }).orWhere({ invoice_slug: ids.invoiceSlug });
            }).first('id');
            if (reused) return outcome('ERRO', 'EXTERNAL_IDENTITY_CONFLICT', current.id);
            if (current.status === 'DIVERGENTE') return outcome('ERRO', 'RECONCILIATION_REQUIRED', current.id);
            const historical = confirmedStates.has(current.status) && current.pago_em && current.provider_verified_at;
            const amount = Number(current.valor_centavos);
            if (!Number.isSafeInteger(amount) || amount !== orderCents(lockedOrder.valor_total) || proof.amount !== amount) {
                await trx('pagamentos').where({ id: current.id }).update({ error_code: 'AMOUNT_MISMATCH', last_checked_at: instant,
                    ...(historical ? {} : { status: 'DIVERGENTE', valor_base_provider_centavos: proof.amount, valor_pago_provider_centavos: proof.paidAmount }) });
                return outcome('ERRO', 'AMOUNT_MISMATCH', current.id);
            }
            if (signal.type === 'refunded' && proof.financialState !== 'ESTORNADA') return outcome('PENDENTE', 'LIFECYCLE_UNVERIFIED', current.id);
            if (proof.financialState === 'ESTORNADA' && !historical) {
                await trx('pagamentos').where({ id: current.id }).update({ status: 'DIVERGENTE', error_code: 'REFUND_RECONCILIATION_REQUIRED' });
                return outcome('ERRO', 'REFUND_RECONCILIATION_REQUIRED', current.id);
            }
            // Independent financial evidence advances monotonically; event names never set these states.
            const target = proof.financialState || 'PAGA';
            const next = current.status === 'ESTORNADA' || (current.status === 'LIQUIDADA' && target === 'PAGA') ? current.status : target;
            await trx('pagamentos').where({ id: current.id }).update({ status: next, bloqueia_nova_cobranca: true, transaction_nsu: ids.transactionNsu, invoice_slug: ids.invoiceSlug,
                valor_base_provider_centavos: proof.amount, valor_pago_provider_centavos: proof.paidAmount, capture_method: proof.captureMethod,
                installments: proof.installments, provider_verified_at: instant, pago_em: current.pago_em || instant, last_checked_at: instant,
                atualizado_em: instant, error_code: null,
                ...(next === 'LIQUIDADA' ? { liquidado_em: current.liquidado_em || instant } : {}),
                ...(next === 'ESTORNADA' ? { estornado_em: current.estornado_em || instant } : {}),
                ...(safeReceipt(proof.receiptUrl, origins) ? { receipt_url: safeReceipt(proof.receiptUrl, origins) }
                    : receiptMatchesTransaction(signal.receiptUrl,ids.transactionNsu,[...origins]) ? { receipt_url: signal.receiptUrl } : {}) });
            if (next !== 'ESTORNADA') {
                if (!lockedOrder.liberado_cozinha_em) await trx('pedidos').where({ id: lockedOrder.id }).update({ liberado_cozinha_em: instant });
                await trx('outbox_eventos').insert({ pedido_id: lockedOrder.id, tipo: 'PEDIDO_LIBERADO', chave_unica: 'pedido_liberado:' + lockedOrder.id,
                    payload_reduzido: { pedido_id: lockedOrder.id, pagamento_id: current.id } }).onConflict().ignore();
            }
            return outcome(signal.type === 'settled' && next === 'PAGA' ? 'PENDENTE' : 'CONCLUIDO',
                signal.type === 'settled' && next === 'PAGA' ? 'LIFECYCLE_UNVERIFIED' : null, current.id);
        });
    }
    async function finish(event, result) {
        return db.transaction(async trx => {
            const exhausted = event.tentativas >= maxAttempts;
            const complete = result.status === 'CONCLUIDO';
            const [saved] = await owned(trx('pagamentos_eventos'), event).update({ status_processamento: complete ? 'CONCLUIDO' : exhausted ? 'ERRO' : result.status,
                pagamento_id: result.paymentId || event.pagamento_id, ultimo_erro: result.code,
                processado_em: complete ? time() : null, locked_by: null, locked_until: null,
                proxima_tentativa_em: !complete && !exhausted ? new Date(time().getTime() + retryMs * 2 ** Math.min(event.tentativas - 1, 10)) : null }).returning('*');
            return saved ? dto(saved) : null;
        });
    }
    async function process(eventId) {
        let event;
        try { event = await claim(eventId); } catch { refuse('EVENT_CLAIM_FAILED'); }
        if (!event) return null;
        if (event.exhausted) return dto(event);
        let result;
        try { result = await verify(event); } catch { result = outcome('PENDENTE', 'PROCESSING_FAILED'); }
        try { return await finish(event, result); } catch { refuse('EVENT_ACK_FAILED'); }
    }
    return { receive: raw => receive(raw),
        // A correlated return requests verification; it never supplies a payment proof.
        receiveReturn: input => receive({ source: 'RETURN',
            ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) }, raw => ({ type: 'created', ...raw })),
        processNext: () => process(),
        processEvent: eventId => {
            if (!/^[1-9]\d*$/.test(String(eventId))) refuse('INVALID_EVENT', 400);
            return process(eventId);
        } };
}
