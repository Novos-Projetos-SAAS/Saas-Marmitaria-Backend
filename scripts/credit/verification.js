import { createInfinitepayCheckClient } from '../../src/services/infinitepayCheckClient.js';
import { parseObservedInfinitepayEvent } from '../../src/services/infinitepayObservedContracts.js';
import { createInfinitepayEventsService } from '../../src/services/infinitepayEventsService.js';
import { createPaymentOutboxService } from '../../src/services/paymentOutboxService.js';
import { snapshot } from '../../src/services/paymentOrchestrator.js';
import { decryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { H4, createCreditControl, authorizeCreditOperation, noSecret } from './control.js';
import { openObservation, observeCredit, digest, readCreditBody } from './observations.js';
import { assertFollowupBinding } from './authorization.js';
import { creditProof, composeCreditEvidence } from './evidence.js';
export { creditProof } from './evidence.js';

const blocked=()=>new Error('Verificação H4 bloqueada. Preserve a tentativa e concilie sem nova cobrança.');
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
    async function evidence(reader) {
        const read=async trx=>{
            const rows=await trx('pagamentos_eventos').where({tipo_evento:'H4_OBSERVACAO_PAYMENT_CHECK'});
            if(rows.length!==1)throw Object.assign(blocked(),{code:'CHECK_NOT_AVAILABLE'});
            const bound=await binding(trx),observed=openObservation(rows[0].payload_filtrado,captureKey);
            const dispatch=await trx('pagamentos_eventos').where({event_key:H4.check}).first('pagamento_id');
            if(observed.status!==200 || rows[0].pagamento_id!==bound.payment.id || dispatch?.pagamento_id!==bound.payment.id ||
                digest(JSON.stringify(bound.context))!==digest(JSON.stringify(observed.context)))throw blocked();
            const rawCallbacks=await trx('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_WEBHOOK','H4_OBSERVACAO_RETURN']).orderBy('id');
            const callbacks=[];
            for(const row of rawCallbacks){
                const raw=openObservation(row.payload_filtrado,captureKey);let parsed;
                try{parsed=JSON.parse(raw.body);}catch{continue;}
                if(parsed.order_nsu===bound.expected.orderNsu)callbacks.push({kind:row.tipo_evento.endsWith('RETURN')?'RETURN':'WEBHOOK',raw:parsed,
                    reference:{id:row.id,hash:digest(JSON.stringify(row.payload_filtrado))}});
            }
            const composed=composeCreditEvidence({data:JSON.parse(observed.body),expected:bound.expected,amount:Number(bound.payment.valor_centavos),
                callbacks,returnNonceHash:bound.payment.return_nonce_hash});
            for(const url of [composed.financial.receiptUrl,composed.receipt.url])if(url)noSecret(url,bound.apiKey);
            const manifest={contract:'H4_CREDIT_EVIDENCE_V2',context:bound.context,
                financial:{event_id:rows[0].id,hash:digest(JSON.stringify(rows[0].payload_filtrado))},receipt:composed.receipt};
            return {...composed,bound,fingerprint:digest(JSON.stringify(manifest))};
        };
        if(reader)return read(reader);
        return db.transaction(async trx=>{await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return read(trx);});
    }
    async function evidenceFingerprint(reader) {
        return (await evidence(reader)).fingerprint;
    }
    async function result(reader) {
        try{
            const composed=await evidence(reader),proof=composed.financial;
            return {payment_confirmed:true,observation_only:true,amount:proof.amount,paid_amount:proof.paidAmount,capture_method:proof.captureMethod,
                installments:proof.installments,identifiers_compatible:true,receipt_available:composed.receipt.status==='VALIDATED',
                receipt_status:composed.receipt.status,reconciliation_ready:composed.reconciliationReady,evidence_sources:composed.sources,
                provider_echo_fields:composed.providerEchoFields,receipt_validation:composed.receiptValidation,callback_signature_verified:composed.callbackSignatureVerified};
        }catch(error){return {payment_confirmed:false,observation_only:true,reconciliation_ready:false,receipt_available:false,
            reason:error.code==='CHECK_NOT_AVAILABLE'?'CHECK_NOT_AVAILABLE':'EVIDENCE_INCOMPATIBLE'};}
    }
    async function check({apiKey,authorization,confirmed,transport}) {
        if(typeof apiKey!=='string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey))throw blocked();
        const approval=authorizeCreditOperation(authorization,'CHECK_PAYMENT',{publicOrigin,apiKey,now:now()});
        if(confirmed!==true || typeof transport!=='function')throw blocked();
        const bound=await binding();if(apiKey!==bound.apiKey || approval.amount_centavos!==Number(bound.payment.valor_centavos) || approval.handle!==bound.payment.handle_snapshot)throw blocked();
        assertFollowupBinding(approval,bound);
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
        const bound=await binding(),evaluation=await result();if(approval.amount_centavos!==Number(bound.payment.valor_centavos) || approval.handle!==bound.payment.handle_snapshot ||
            approval.credential_sha256!==digest(bound.apiKey) || !evaluation.payment_confirmed || !evaluation.reconciliation_ready)throw blocked();
        assertFollowupBinding(approval,bound,await evidenceFingerprint());
        return bound;
    }
    async function reconcile({authorization,confirmed}) {
        const bound=await approved('RECONCILE',authorization,confirmed);
        const service=createInfinitepayEventsService({db,now,receiptOrigins:['https://recibo.infinitepay.io'],parseEvent:parseObservedInfinitepayEvent,
            client:{async checkPayment(request){
                const composed=await evidence(),current=composed.bound;
                if(!composed.reconciliationReady || request.apiKey!==current.apiKey || Object.keys(current.expected).some(key=>request[key]!==current.expected[key]))throw blocked();
                assertFollowupBinding(authorization,current,composed.fingerprint);
                return {...composed.financial,...(composed.receipt.url?{receiptUrl:composed.receipt.url}:{}),identifiers:current.expected};
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
    return {binding,result,evidenceFingerprint,check,reconcile,deliver};
}
