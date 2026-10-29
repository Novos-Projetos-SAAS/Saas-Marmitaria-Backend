import { financialHttpError } from '../infinitepayRuntime.js';

const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const identifier=(value,limit)=>typeof value==='string' && value.length>0 && value.length<=limit && value===value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
const providerEvents=new Set(['created','paid','settled','refunded','canceled','payment_failed']);
const confirmedStates=new Set(['PAGA','LIQUIDADA','ESTORNADA']);
const dto=(pedidoId,requestId,status,count)=>({pedido_id:pedidoId,solicitacao_id:requestId,status,eventos_reagendados:count});

function confirmed(payment,order) {
    const amount=Number(payment.valor_centavos);
    return confirmedStates.has(payment.status) && payment.provider_verified_at && payment.pago_em &&
        identifier(payment.transaction_nsu,255) && identifier(payment.invoice_slug,255) &&
        ['pix','credit_card'].includes(payment.capture_method) && Number.isSafeInteger(amount) && amount>0 &&
        Number(payment.valor_base_provider_centavos)===amount && Math.round(Number(order.valor_total)*100)===amount;
}
function usable(event,payment) {
    const signal=event.payload_filtrado;
    if(!providerEvents.has(event.tipo_evento) || !signal || signal.type!==event.tipo_evento || signal.orderNsu!==payment.order_nsu ||
        (event.pagamento_id!==null && String(event.pagamento_id)!==String(payment.id)))return false;
    const transaction=signal.transactionNsu ?? payment.transaction_nsu,invoice=signal.invoiceSlug ?? payment.invoice_slug;
    return identifier(payment.order_nsu,120) && identifier(transaction,255) && identifier(invoice,255) &&
        (!payment.transaction_nsu || transaction===payment.transaction_nsu) && (!payment.invoice_slug || invoice===payment.invoice_slug);
}

// This service only schedules previously received evidence. The existing worker
// remains responsible for independent verification, authorization and release.
export function createAdministrativePaymentReconciliation({db,now=()=>new Date()}={}) {
    if(typeof db!=='function' || typeof db.transaction!=='function' || typeof now!=='function')throw new TypeError('Conciliação administrativa indisponível.');
    async function request({pedidoId,actorId,input}) {
        if(!Number.isSafeInteger(pedidoId) || pedidoId<1 || pedidoId>2147483647)throw financialHttpError(404);
        if(!input || Array.isArray(input) || typeof input!=='object' || Object.keys(input).length!==1 || !uuid(input.request_id))throw financialHttpError(400);
        const requestId=input.request_id.toLowerCase(),key='admin_conciliacao:'+requestId;
        return db.transaction(async trx=>{
            // Hold the actual permission through commit; a JWT role is never a grant.
            const actor=await trx('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
                .join('permissoes_usuarios as pu','pu.usuario_id','u.id').join('permissoes as p','p.id','pu.permissao_id')
                .where({'u.id':actorId,'u.ativo':true,'n.ativo':true,'p.nome':'pagamentos.conciliar'}).whereNull('u.deletado_em')
                .select('u.id').forShare().first();
            if(!actor)throw financialHttpError(403);
            // Serialize a request UUID even when two callers choose different orders.
            await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[key]);
            const previous=await trx('pagamentos_eventos').where({event_key:key}).first();
            if(previous) {
                const audit=previous.payload_filtrado;
                if(previous.tipo_evento!=='ADMIN_CONCILIACAO' || previous.status_processamento!=='CONCLUIDO' ||
                    audit?.pedido_id!==pedidoId || audit.usuario_id!==actorId)throw financialHttpError(409);
                return dto(pedidoId,requestId,audit.resultado,audit.eventos.length);
            }
            const order=await trx('pedidos').where({id:pedidoId}).whereNull('deletado_em').forUpdate().first();
            if(!order)throw financialHttpError(404);
            if(order.fluxo_pagamento!=='INFINITEPAY')throw financialHttpError(409);
            const payment=await trx('pagamentos').where({pedido_id:pedidoId,provedor:'INFINITEPAY'}).orderBy('tentativa_numero','desc').forUpdate().first();
            if(!payment)throw financialHttpError(409);
            const instant=now();if(!(instant instanceof Date) || !Number.isFinite(instant.getTime()))throw financialHttpError(503);
            let status='JA_CONFIRMADO',changes=[];
            if(!confirmed(payment,order)) {
                if(!['INCERTA','DIVERGENTE'].includes(payment.status))throw financialHttpError(409);
                const events=await trx('pagamentos_eventos').whereNot({tipo_evento:'ADMIN_CONCILIACAO'})
                    .where(function(){this.where({pagamento_id:payment.id}).orWhereRaw("payload_filtrado->>'orderNsu' = ?",[payment.order_nsu]);})
                    .orderBy('id').forUpdate().skipLocked();
                const identifiable=events.filter(event=>usable(event,payment));
                status=identifiable.length?'SOLICITADA':'SEM_IDENTIFICADORES';
                changes=identifiable.filter(event=>['PENDENTE','PENDENTE_IDENTIFICACAO','ERRO'].includes(event.status_processamento) &&
                    !event.locked_by && !event.locked_until && !(event.status_processamento==='PENDENTE' && event.tentativas<5 &&
                        (!event.proxima_tentativa_em || new Date(event.proxima_tentativa_em)<=instant)));
            }
            const audit={version:1,pedido_id:pedidoId,usuario_id:actorId,resultado:status,eventos:changes.map(event=>({
                id:event.id,status_anterior:event.status_processamento,tentativas_anteriores:event.tentativas,erro_anterior:event.ultimo_erro,
                processado_em_anterior:event.processado_em,proxima_tentativa_em_anterior:event.proxima_tentativa_em}))};
            // Audit and all resets commit together. Audit failure cannot discard a retry history.
            await trx('pagamentos_eventos').insert({pagamento_id:payment.id,event_key:key,tipo_evento:'ADMIN_CONCILIACAO',
                payload_filtrado:audit,status_processamento:'CONCLUIDO',recebido_em:instant,processado_em:instant});
            for(const event of changes)await trx('pagamentos_eventos').where({id:event.id}).update({status_processamento:'PENDENTE',
                tentativas:event.tentativas>=5?0:event.tentativas,ultimo_erro:null,processado_em:null,proxima_tentativa_em:instant});
            return dto(pedidoId,requestId,status,changes.length);
        });
    }
    return {request};
}
