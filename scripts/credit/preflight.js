import { randomBytes, randomUUID } from 'node:crypto';
import { H4, createCreditControl } from './control.js';
import { digest, sealObservation, openObservation } from './observations.js';

export async function prepareCreditProbe({db,captureKey,now=()=>new Date()}) {
    return db.transaction(async trx=>{
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['h4:control']);
        if(await trx('pagamentos_eventos').where({event_key:H4.command}).first())throw new Error('Pré-teste com novo fixture bloqueado após reserva real.');
        const old=await trx('pagamentos_eventos').where({tipo_evento:'H4_PRETESTE'}).orderBy('id','desc').first();
        if(old){const value=openObservation(old.payload_filtrado,captureKey);if(Date.parse(value.expires)>now().getTime())return value;}
        let method=await trx('metodos_pagamento').where({codigo:'CARTAO_CREDITO'}).first();
        if(!method)[method]=await trx('metodos_pagamento').insert({nome:'H4 Crédito sintético',codigo:'CARTAO_CREDITO',tipo_financeiro:'CREDITO'}).returning('*');
        if(method.tipo_financeiro!=='CREDITO')throw new Error('Classificação incompatível.');
        const [order]=await trx('pedidos').insert({nome_cliente:'H4 PRETESTE SINTETICO SEM COBRANCA',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
            metodo_pagamento_id:method.id,valor_total:1,fluxo_pagamento:'INFINITEPAY'}).returning('*');
        const nonce=randomBytes(32).toString('base64url'),orderNsu='H4-PREFLIGHT-'+randomUUID(),expires=new Date(now().getTime()+86400000).toISOString();
        const [payment]=await trx('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:orderNsu,status:'FALHOU',bloqueia_nova_cobranca:false,
            valor_centavos:100,return_nonce_hash:digest(nonce),valid_until:expires}).returning('id');
        const value={nonce,orderNsu,expires,paymentId:payment.id,orderId:order.id};
        await trx('pagamentos_eventos').insert({event_key:H4.probe+':'+orderNsu,tipo_evento:'H4_PRETESTE',pagamento_id:payment.id,
            payload_filtrado:sealObservation(value,captureKey),status_processamento:'PENDENTE_IDENTIFICACAO'});
        return value;
    });
}
export async function verifyCreditEndpoints({db,captureKey,publicOrigin,transport=globalThis.fetch}) {
    const control=createCreditControl({db,captureKey,publicOrigin});await control.pinned();
    const call=async(path,expected,init={})=>{
        const response=await transport(publicOrigin+path,{redirect:'manual',signal:AbortSignal.timeout(15000),...init});
        if(response.status!==expected)throw new Error('Pré-teste HTTPS H4 não confirmado.');return response;
    };
    await call('/pedido/sucesso',200);await call('/pagamentos/infinitepay/webhook',405);await call('/pagamentos/infinitepay/retorno',400);
    for(const path of ['/links','/payment_check','/pedidos','/qz/assinar','/socket.io/'])await call(path,404);
    await call('/pagamentos/infinitepay/retorno',405,{method:'POST'});
    await call('/pagamentos/infinitepay/webhook',415,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
    const orderNsu='H4-HTTPS-PROBE-'+randomUUID();
    const body=JSON.stringify({event_type:'created',order_nsu:orderNsu,invoice_slug:'SYNTHETIC-PREFLIGHT'});
    for(let n=0;n<2;n++)await call('/pagamentos/infinitepay/webhook',200,{method:'POST',headers:{'Content-Type':'application/json'},body});
    const events=await db('pagamentos_eventos').whereRaw("payload_filtrado->>'orderNsu'=?",[orderNsu]);
    if(events.length!==1 || events[0].status_processamento!=='PENDENTE')throw new Error('Persistência/deduplicação não confirmada.');
    const probe=await prepareCreditProbe({db,captureKey});
    const response=await call('/pagamentos/infinitepay/retorno?'+new URLSearchParams({r:probe.nonce,order_nsu:probe.orderNsu,
        transaction_nsu:'SYNTHETIC-H4-PREFLIGHT-TX',slug:'SYNTHETIC-H4-PREFLIGHT-INVOICE'}),303);
    const location=new URL(response.headers.get('location'));
    if(location.origin!==publicOrigin || location.pathname!=='/pedido/sucesso' || !location.hash.startsWith('#ref='))throw new Error('Retorno incompatível.');
    const payment=await db('pagamentos').where({id:probe.paymentId}).first();
    if(payment.status!=='FALHOU' || (await db('pedidos').where({id:probe.orderId}).first()).liberado_cozinha_em ||
        Number((await db('outbox_eventos').count('* as n').first()).n)!==0)throw new Error('Isolamento não confirmado.');
    return {https:true,webhook_post:200,deduplicated:true,return_get:303,nonce_correlated:true,financial_requests:0,
        financial_worker:false,kitchen_released:false,checked_at:new Date().toISOString()};
}
