import { randomUUID } from 'node:crypto';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';

class DeliveryError extends Error {
    constructor(code) { super('Não foi possível confirmar o recebimento operacional.'); this.code = code; }
}
const refuse = code => { throw new DeliveryError(code); };
const keyValid = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 255 && !/[\p{Cc}\p{Cf}]/u.test(value);
const positiveId = value => /^[1-9]\d*$/.test(String(value));

export function createDurableOrderConsumer({ db, adapter, now = () => new Date(), leaseMs = 30000, maxAttempts = 5, authorizeSend = async () => true,
    timeoutMs = Math.min(5000, leaseMs) } = {}) {
    if (typeof db !== 'function' || typeof db.transaction !== 'function' || typeof now !== 'function' || typeof authorizeSend !== 'function' ||
        !adapter || typeof adapter.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(adapter.id) || typeof adapter.supportsIdempotency !== 'boolean' ||
        ['send','lookupReceipt','verifyReceipt'].some(name => typeof adapter[name] !== 'function') ||
        ![leaseMs, maxAttempts, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
        leaseMs > 86400000 || timeoutMs > leaseMs || maxAttempts > 100) throw new TypeError('Contrato do consumidor operacional inválido.');
    const destination = adapter.id, idempotent = adapter.supportsIdempotency;
    function time() {
        const instant = now(); if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) refuse('DELIVERY_CLOCK_INVALID'); return instant;
    }
    function dto(input) {
        if (!input || !positiveId(input.id) || !positiveId(input.pedidoId) || !keyValid(input.key) || input.tipo !== 'PEDIDO_LIBERADO') refuse('DELIVERY_IDENTITY_CONFLICT');
        return Object.freeze({ id: input.id, pedidoId: input.pedidoId, tipo: input.tipo, key: input.key });
    }
    function receipt(row) {
        return { acknowledged: true, key: row.chave_unica, pedidoId: row.pedido_id, destination: row.destino, receiptId: row.receipt_id };
    }
    async function eligible(reader, value) {
        const found = await aplicarElegibilidadeOperacional(reader('pedidos'), { confirmedStates: ['PAGA', 'LIQUIDADA'] }).where('pedidos.id', value.pedidoId)
            .where('pedidos.fluxo_pagamento', 'INFINITEPAY').whereNull('pedidos.deletado_em')
            .first('pedidos.id');
        if (!found) refuse('ORDER_INELIGIBLE');
    }
    async function claim(value, recovery) {
        return db.transaction(async trx => {
            const outbox = await trx('outbox_eventos').where({ id: value.id, pedido_id: value.pedidoId, chave_unica: value.key, tipo: value.tipo }).first();
            if (!outbox) refuse('DELIVERY_IDENTITY_CONFLICT');
            if (!recovery) {
                const previous = await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key }).first();
                if (!previous) {
                    await eligible(trx, value);
                    await trx('infinitepay_entregas_operacionais').insert({ chave_unica: value.key, outbox_id: value.id, pedido_id: value.pedidoId,
                        destino: destination, criado_em: time(), atualizado_em: time() }).onConflict('chave_unica').ignore();
                }
            }
            const row = await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key }).forUpdate().first();
            if (!row || row.destino !== destination || String(row.outbox_id) !== String(value.id) || String(row.pedido_id) !== String(value.pedidoId)) refuse('DELIVERY_IDENTITY_CONFLICT');
            if (row.status === 'RECEBIDA') return { received: receipt(row) };
            const instant = time();
            if (row.status === 'ENVIANDO') {
                if (new Date(row.locked_until) > instant) refuse('DELIVERY_BUSY');
                await trx('infinitepay_entregas_tentativas').where({ token: row.locked_by, status: 'ENVIANDO' })
                    .update({ status: 'INCERTA', ultimo_erro: 'LEASE_EXPIRED', finalizado_em: instant });
                await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key })
                    .update({ status: 'INCERTA', locked_by: null, locked_until: null, ultimo_erro: 'LEASE_EXPIRED', atualizado_em: instant });
                row.status = 'INCERTA';
            }
            // A lease proves ownership, never that a remote side effect did not happen.
            if (!recovery && row.status !== 'PENDENTE') return { blocked: 'RECOVERY_REQUIRED' };
            if (row.tentativas >= maxAttempts) return { blocked: 'DELIVERY_ATTEMPTS_EXHAUSTED' };
            if (!recovery) await eligible(trx, value);
            const token = randomUUID(), number = row.tentativas + 1;
            await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key }).update({ status: 'ENVIANDO', tentativas: number,
                locked_by: token, locked_until: new Date(instant.getTime() + leaseMs), ultimo_erro: null, atualizado_em: instant });
            await trx('infinitepay_entregas_tentativas').insert({ chave_unica: value.key, numero: number, token,
                operacao: recovery ? 'RECUPERACAO' : 'ENVIO', status: 'ENVIANDO', iniciado_em: instant });
            return { token };
        });
    }
    async function stillOwned(value, token) {
        const row=await db('infinitepay_entregas_operacionais').where({ chave_unica: value.key, locked_by: token, status: 'ENVIANDO' })
            .where('locked_until', '>', time()).first('locked_until');
        if(!row || new Date(row.locked_until)<=time()) refuse('DELIVERY_LEASE_LOST');
    }
    async function deadline(action) {
        const controller = new AbortController(); let timer;
        try {
            return await Promise.race([Promise.resolve().then(() => action(controller.signal)), new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new DeliveryError('DESTINATION_UNCERTAIN')); }, timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    async function validateReceipt(candidate, value) {
        if (!candidate || candidate.acknowledged !== true || candidate.key !== value.key || String(candidate.pedidoId) !== String(value.pedidoId) ||
            candidate.destination !== destination || !keyValid(candidate.receiptId)) refuse('RECEIPT_INVALID');
        if (await deadline(signal => adapter.verifyReceipt(candidate, value, { signal })) !== true) refuse('RECEIPT_INVALID');
        return candidate.receiptId;
    }
    async function accept(value, token, receiptId) {
        return db.transaction(async trx => {
            const instant = time();
            const row = await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key, locked_by: token, status: 'ENVIANDO' })
                .where('locked_until', '>', instant).forUpdate().first();
            if (!row) refuse('DELIVERY_LEASE_LOST');
            await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key }).update({ status: 'RECEBIDA', receipt_id: receiptId,
                recebido_em: instant, atualizado_em: instant, ultimo_erro: null, locked_by: null, locked_until: null });
            await trx('infinitepay_entregas_tentativas').where({ token, status: 'ENVIANDO' }).update({ status: 'RECEBIDA', finalizado_em: instant });
            return receipt({ ...row, receipt_id: receiptId });
        });
    }
    async function fail(value, token, code) {
        await db.transaction(async trx => {
            const instant = time();
            const changed = await trx('infinitepay_entregas_operacionais').where({ chave_unica: value.key, locked_by: token, status: 'ENVIANDO' })
                .update({ status: 'INCERTA', ultimo_erro: code, locked_by: null, locked_until: null, atualizado_em: instant });
            if (changed) await trx('infinitepay_entregas_tentativas').where({ token, status: 'ENVIANDO' })
                .update({ status: 'INCERTA', ultimo_erro: code, finalizado_em: instant });
        });
    }
    async function process(value, recovery) {
        let owned;
        try {
            owned = await claim(value, recovery);
            if (owned.received) return owned.received;
            if (owned.blocked) refuse(owned.blocked);
            let candidate;
            if (recovery) {
                try { candidate = await deadline(signal => adapter.lookupReceipt(value, { signal })); }
                catch { refuse('DESTINATION_UNCERTAIN'); }
                if (candidate === null) {
                    if (!idempotent) refuse('RECOVERY_REQUIRES_IDEMPOTENCY');
                } else return await accept(value, owned.token, await validateReceipt(candidate, value));
            }
            if(await deadline(signal => authorizeSend(value,{signal})) !== true) refuse('DELIVERY_NOT_AUTHORIZED');
            // Authorization may be slow. Ownership must be checked after it, immediately before send.
            await eligible(db, value); await stillOwned(value, owned.token);
            try { candidate = await deadline(signal => adapter.send(value, { signal })); }
            catch { refuse('DESTINATION_UNCERTAIN'); }
            return await accept(value, owned.token, await validateReceipt(candidate, value));
        } catch (error) {
            const safe = error instanceof DeliveryError ? error : new DeliveryError('DELIVERY_STORAGE_FAILED');
            if (owned?.token) { try { await fail(value, owned.token, safe.code); } catch { /* A durable lease remains recoverable after storage failure. */ } }
            throw safe;
        }
    }
    return {
        deliver: input => process(dto(input), false),
        async recover(key) {
            if (!keyValid(key)) refuse('DELIVERY_IDENTITY_CONFLICT');
            let row;
            try { row = await db('infinitepay_entregas_operacionais').where({ chave_unica: key }).first(); }
            catch { refuse('DELIVERY_STORAGE_FAILED'); }
            if (!row) refuse('DELIVERY_IDENTITY_CONFLICT');
            return process(dto({ id: row.outbox_id, pedidoId: row.pedido_id, tipo: 'PEDIDO_LIBERADO', key }), true);
        }
    };
}
