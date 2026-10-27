import { createInfinitepayCheckClient, normalizedPayment } from '../../src/services/infinitepayCheckClient.js';
import { parseObservedPaymentCheck, parseObservedInfinitepayEvent } from '../../src/services/infinitepayObservedContracts.js';
import { createInfinitepayEventsService } from '../../src/services/infinitepayEventsService.js';
import { createPaymentOutboxService } from '../../src/services/paymentOutboxService.js';
import { snapshot } from '../../src/services/paymentOrchestrator.js';
import { decryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { H4, createCreditControl, authorizeCreditOperation, noSecret } from './control.js';
import { openObservation, observeCredit, digest, readCreditBody } from './observations.js';

const blocked=()=>new Error('Verificação H4 bloqueada. Preserve a tentativa e concilie sem nova cobrança.');
export function creditProof(data,expected,amount) {
    if(data?.success!==true || data.paid!==true || data.amount!==amount || data.capture_method!=='credit_card' || data.installments!==1 || !data.receipt_url)throw blocked();
    return normalizedPayment(parseObservedPaymentCheck(data,expected),expected,new Set(['https://recibo.infinitepay.io']));
}
export function createCreditVerification({db,captureKey,publicOrigin,now=()=>new Date()}) {
    const control=createCreditControl({db,captureKey,publicOrigin,now});
    async function binding(trx=db) {
        await control.pinned(trx);const {marker,payment}=await control.original(trx);if(!marker || !payment)throw blocked();
        const saved=openObservation(marker.payload_filtrado,captureKey),order=await trx('pedidos').where({id:payment.pedido_id}).whereNull('deletado_em').first();
        const method=order && await trx('metodos_pagamento').where({id:order.metodo_pagamento_id}).first();
        if(!order || order.fluxo_pagamento!=='INFINITEPAY' || method?.codigo!=='CARTAO_CREDITO' || method.tipo_financeiro!=='CREDITO' ||
            (saved.approval.schema_version===2 && order.client_request_id!==saved.approval.attempt_reference) ||
            Number(payment.valor_centavos)!==saved.approval.amount_centavos || payment.order_nsu!==saved.request.order_nsu || payment.handle_snapshot!==saved.approval.handle)throw blocked();
        const items=await trx('itens_pedido').where({pedido_id:order.id}).orderBy('id');
        const composition=await trx('composicao_item_pedido').whereIn('item_pedido_id',items.map(item=>item.id)).orderBy('item_pedido_id').orderBy('alimento_id');
        if(snapshot(order,items,composition,method).payloadHash!==order.client_payload_hash)throw blocked();
        const credential=await trx('infinitepay_credenciais').where({id:payment.credencial_id,handle:payment.handle_snapshot}).first();
        const apiKey=decryptApiKey(credential,payment.handle_snapshot);if(digest(apiKey)!==saved.approval.credential_sha256)throw blocked();
        const transactions=new Set(),invoices=new Set();
        const observations=await trx('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_WEBHOOK','H4_OBSERVACAO_RETURN']);
        for(const row of observations){
            const observed=openObservation(row.payload_filtrado,captureKey);let raw;
            try{raw=JSON.parse(observed.body);}catch{continue;}
            if(raw.order_nsu!==payment.order_nsu)continue;
            if(row.tipo_evento==='H4_OBSERVACAO_RETURN'){
                if(typeof raw.r!=='string' || digest(raw.r)!==payment.return_nonce_hash)throw blocked();
                if(raw.invoice_slug && raw.slug && raw.invoice_slug!==raw.slug)throw blocked();
                if(raw.transaction_nsu)transactions.add(raw.transaction_nsu);if(raw.slug)invoices.add(raw.slug);
            }else{
                const parsed=parseObservedInfinitepayEvent(raw);
                if(parsed.transactionNsu)transactions.add(parsed.transactionNsu);invoices.add(parsed.invoiceSlug);
            }
        }
        if(transactions.size!==1 || invoices.size!==1)throw blocked();
        const expected={orderNsu:payment.order_nsu,transactionNsu:[...transactions][0],invoiceSlug:[...invoices][0]};
        if((payment.transaction_nsu && payment.transaction_nsu!==expected.transactionNsu) || (payment.invoice_slug && payment.invoice_slug!==expected.invoiceSlug))throw blocked();
        const context={attempt:payment.id,order:order.id,credential:payment.credencial_id,handle:payment.handle_snapshot,
            amount:Number(payment.valor_centavos),snapshot:order.client_payload_hash,expected};
        return {payment,saved,apiKey,expected,context};
    }
    async function result() {
        return db.transaction(async trx=>{
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const observations=await trx('pagamentos_eventos').where({tipo_evento:'H4_OBSERVACAO_PAYMENT_CHECK'});
            if(observations.length!==1)return {payment_confirmed:false,observation_only:true,reason:'CHECK_NOT_AVAILABLE'};
            try{
                const current=await binding(trx),observed=openObservation(observations[0].payload_filtrado,captureKey);
                if(observed.status!==200 || digest(JSON.stringify(current.context))!==digest(JSON.stringify(observed.context)))throw blocked();
                const proof=creditProof(JSON.parse(observed.body),current.expected,Number(current.payment.valor_centavos));noSecret(proof.receiptUrl,current.apiKey);
                return {payment_confirmed:true,observation_only:true,amount:proof.amount,paid_amount:proof.paidAmount,capture_method:proof.captureMethod,
                    installments:proof.installments,identifiers_compatible:true,receipt_available:true};
            }catch{return {payment_confirmed:false,observation_only:true,reason:'EVIDENCE_INCOMPATIBLE'};}
        });
    }
    async function check({apiKey,authorization,confirmed,transport}) {
        if(typeof apiKey!=='string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey))throw blocked();
        const approval=authorizeCreditOperation(authorization,'CHECK_PAYMENT',{publicOrigin,apiKey,now:now()});
        if(confirmed!==true || typeof transport!=='function')throw blocked();
        const bound=await binding();if(apiKey!==bound.apiKey || approval.amount_centavos!==Number(bound.payment.valor_centavos) || approval.handle!==bound.payment.handle_snapshot)throw blocked();
        const reserved=await db.transaction(async trx=>{
            await trx.raw('SET LOCAL synchronous_commit=on');await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['h4:control']);
            const [row]=await trx('pagamentos_eventos').insert({event_key:H4.check,tipo_evento:'H4_RESERVA_PAYMENT_CHECK',pagamento_id:bound.payment.id,
                status_processamento:'PENDENTE_IDENTIFICACAO'}).onConflict('event_key').ignore().returning('id');return Boolean(row);
        });
        if(!reserved)return result();
        const client=createInfinitepayCheckClient({receiptOrigins:['https://recibo.infinitepay.io'],parsePaymentCheck:(data,expected)=>creditProof(data,expected,approval.amount_centavos),
            transport:async(url,init)=>{
                authorizeCreditOperation(approval,'CHECK_PAYMENT',{publicOrigin,apiKey,now:now()});
                const response=await transport(url,init),body=await readCreditBody(response);
                await observeCredit(db,captureKey,'PAYMENT_CHECK',{status:response.status,body,context:bound.context},bound.payment.id);
                return new Response(body,{status:response.status,headers:{'Content-Type':'application/json'}});
            }});
        try{await client.checkPayment({apiKey,handle:bound.payment.handle_snapshot,...bound.expected});}
        catch{await db('pagamentos').where({id:bound.payment.id}).whereIn('status',['CRIANDO','AGUARDANDO','INCERTA']).update({status:'INCERTA'});}
        return result();
    }
    async function approved(operation,authorization,confirmed) {
        const approval=authorizeCreditOperation(authorization,operation,{publicOrigin,now:now()});if(confirmed!==true)throw blocked();
        const bound=await binding();if(approval.amount_centavos!==Number(bound.payment.valor_centavos) || approval.handle!==bound.payment.handle_snapshot ||
            approval.credential_sha256!==digest(bound.apiKey) || !(await result()).payment_confirmed)throw blocked();
        return bound;
    }
    async function reconcile({authorization,confirmed}) {
        const bound=await approved('RECONCILE',authorization,confirmed);
        const service=createInfinitepayEventsService({db,now,receiptOrigins:['https://recibo.infinitepay.io'],parseEvent:parseObservedInfinitepayEvent,
            client:{async checkPayment(request){
                const current=await binding();if(request.apiKey!==current.apiKey || Object.keys(current.expected).some(key=>request[key]!==current.expected[key]))throw blocked();
                const row=await db('pagamentos_eventos').where({tipo_evento:'H4_OBSERVACAO_PAYMENT_CHECK',pagamento_id:bound.payment.id}).first();
                const observed=openObservation(row.payload_filtrado,captureKey);
                if(digest(JSON.stringify(current.context))!==digest(JSON.stringify(observed.context)))throw blocked();
                return {...creditProof(JSON.parse(observed.body),current.expected,current.context.amount),identifiers:current.expected};
            }}});
        const event=await service.receiveReturn(bound.expected);await service.processEvent(event.eventId);
        return control.status();
    }
    async function deliver({authorization,confirmed}) {
        const bound=await approved('DELIVER',authorization,confirmed);
        if(!['PAGA','LIQUIDADA'].includes((await db('pagamentos').where({id:bound.payment.id}).first()).status))throw blocked();
        const service=createPaymentOutboxService({db,now,deliver:async dto=>{
            if(dto.pedidoId!==bound.payment.pedido_id)throw blocked();
            await db('infinitepay_entregas_homologacao').insert({chave_unica:dto.key,pedido_id:dto.pedidoId}).onConflict('chave_unica').ignore();
        }});
        const rows=await db('outbox_eventos').where({pedido_id:bound.payment.pedido_id,tipo:'PEDIDO_LIBERADO'});if(rows.length!==1)throw blocked();
        await service.processEvent(rows[0].id);
        return {isolated:true,deliveries:Number((await db('infinitepay_entregas_homologacao').where({pedido_id:bound.payment.pedido_id}).count('* as n').first()).n)};
    }
    return {binding,result,check,reconcile,deliver};
}
