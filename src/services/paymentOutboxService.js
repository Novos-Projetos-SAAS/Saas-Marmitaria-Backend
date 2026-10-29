import { randomUUID } from 'node:crypto';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';

export function createPaymentOutboxService({ db, deliver, now = () => new Date(), leaseMs = 30000, retryMs = 1000, maxAttempts = 5 }) {
    if (typeof deliver !== 'function') throw new TypeError('deliver é obrigatório.');
    if (![leaseMs, retryMs, maxAttempts].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Lease, intervalo e limite de tentativas devem ser inteiros positivos.');
    }

    async function claim(eventId) {
        const time = now();
        return db.transaction(async trx => {
            // Este lock nunca é seguido por locks de pedido/pagamento: o verificador usa a ordem inversa.
            const row = await trx('outbox_eventos')
                .select('id', 'pedido_id', 'tipo', 'chave_unica', 'tentativas')
                .where({ tipo: 'PEDIDO_LIBERADO' })
                .where(function () {
                    this.where(function () {
                        this.whereIn('status', ['PENDENTE', 'ERRO']).where('tentativas', '<', maxAttempts).where(function () {
                            this.whereNull('proxima_tentativa_em').orWhere('proxima_tentativa_em', '<=', time);
                        });
                    }).orWhere(function () {
                        this.where({ status: 'PROCESSANDO' }).where('locked_until', '<=', time);
                    });
                })
                .modify(query => { if (eventId !== undefined) query.where({ id: eventId }); })
                .orderBy('criado_em').orderBy('id').forUpdate().skipLocked().first();
            if (!row) return null;
            if (row.tentativas >= maxAttempts) {
                await trx('outbox_eventos').where({ id: row.id }).update({ status: 'ERRO',
                    locked_by: null, locked_until: null, proxima_tentativa_em: null });
                return null;
            }
            const token = randomUUID();
            await trx('outbox_eventos').where({ id: row.id }).update({ status: 'PROCESSANDO',
                tentativas: row.tentativas + 1, locked_by: token, locked_until: new Date(time.getTime() + leaseMs),
                proxima_tentativa_em: null });
            return { ...row, tentativas: row.tentativas + 1, token };
        });
    }

    function owned(row) {
        return db('outbox_eventos').where({ id: row.id, locked_by: row.token, status: 'PROCESSANDO' });
    }

    async function retry(row) {
        const delay = retryMs * 2 ** Math.min(row.tentativas - 1, 20);
        await owned(row).update({ status: 'ERRO', locked_by: null, locked_until: null,
            proxima_tentativa_em: row.tentativas < maxAttempts ? new Date(now().getTime() + delay) : null });
    }

    async function processOne(eventId) {
        const row = await claim(eventId);
        if (!row) return null;
        const eligible = await aplicarElegibilidadeOperacional(db('pedidos'))
            .where('pedidos.id', row.pedido_id).where('pedidos.fluxo_pagamento', 'INFINITEPAY').first('pedidos.id');
        if (!eligible) {
            await retry(row);
            return null;
        }
        // Uma checagem lenta não autoriza o worker antigo a iniciar uma entrega depois do lease.
        if (!await owned(row).where('locked_until', '>', now()).first('id')) return null;
        const dto = Object.freeze({ id: row.id, pedidoId: row.pedido_id, tipo: row.tipo, key: row.chave_unica });
        try { await deliver(dto); }
        catch (error) {
            await retry(row);
            throw error;
        }
        // Envio e ack não são atômicos. Falha aqui preserva o lease para reentrega com a mesma chave.
        const acknowledged = await owned(row).update({ status: 'CONCLUIDO', processado_em: now(),
            locked_by: null, locked_until: null, proxima_tentativa_em: null });
        return acknowledged ? dto : null;
    }

    async function processNext(eventId) {
        try { return await processOne(eventId); }
        catch {
            throw Object.assign(new Error('Não foi possível processar a entrega financeira.'), { code: 'OUTBOX_PROCESSING_FAILED' });
        }
    }

    async function ackRecovered(input, receipt) {
        const refuse=code=>{throw Object.assign(new Error('Não foi possível reconhecer a entrega recuperada.'),{code,statusCode:409});};
        if(!input || !/^[1-9]\d*$/.test(String(input.id)) || !/^[1-9]\d*$/.test(String(input.pedidoId)) ||
            input.tipo!=='PEDIDO_LIBERADO' || typeof input.key!=='string' || !input.key || receipt?.acknowledged!==true ||
            receipt.key!==input.key || String(receipt.pedidoId)!==String(input.pedidoId) ||
            typeof receipt.destination!=='string' || typeof receipt.receiptId!=='string' || !receipt.receiptId.trim())refuse('OUTBOX_RECOVERY_INVALID');
        return db.transaction(async trx=>{
            // Lock only outbox/delivery rows, never acquire a later order/payment lock.
            const row=await trx('outbox_eventos').where({id:input.id,pedido_id:input.pedidoId,tipo:input.tipo,chave_unica:input.key}).forUpdate().first();
            if(!row)refuse('OUTBOX_RECOVERY_INVALID');
            const instant=now();if(!(instant instanceof Date) || !Number.isFinite(instant.getTime()))refuse('OUTBOX_RECOVERY_INVALID');
            if(row.status==='PROCESSANDO' && (!row.locked_until || new Date(row.locked_until)>instant))refuse('OUTBOX_RECOVERY_BUSY');
            const ledger=await trx('infinitepay_entregas_operacionais').where({chave_unica:input.key}).forUpdate().first();
            if(!ledger || ledger.status!=='RECEBIDA' || String(ledger.outbox_id)!==String(row.id) ||
                String(ledger.pedido_id)!==String(row.pedido_id) || ledger.destino!==receipt.destination ||
                ledger.receipt_id!==receipt.receiptId || !ledger.recebido_em)refuse('OUTBOX_RECOVERY_INVALID');
            if(row.status!=='CONCLUIDO')await trx('outbox_eventos').where({id:row.id}).update({status:'CONCLUIDO',processado_em:instant,
                locked_by:null,locked_until:null,proxima_tentativa_em:null});
            return {id:row.id,pedidoId:row.pedido_id,tipo:row.tipo,key:row.chave_unica};
        });
    }

    return { ackRecovered, processNext: () => processNext(), processEvent: eventId => {
        if (!/^[1-9]\d*$/.test(String(eventId))) throw new TypeError('Evento de saída inválido.');
        return processNext(eventId);
    } };
}
