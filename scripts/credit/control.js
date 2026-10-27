import { randomUUID } from 'node:crypto';
import { createPaymentOrchestrator } from '../../src/services/paymentOrchestrator.js';
import { createInfinitepayClient } from '../../src/services/infinitepayClient.js';
import { parseObservedCreatedLink } from '../../src/services/infinitepayObservedContracts.js';
import { encryptApiKey, decryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { aplicarElegibilidadeOperacional } from '../../src/utils/pedidoPaymentPolicy.js';
import { validateCreationScope } from './authorization.js';
import { digest, sealObservation, openObservation, observeCredit, readCreditBody } from './observations.js';

export const H4={origin:'h4:public-origin',command:'h4:links:command',dispatch:'h4:links:dispatch',check:'h4:check:dispatch',probe:'h4:preflight:probe'};
const blocked=()=>new Error('H4 bloqueada: autorização, ambiente ou evidência indisponível. Não repita envio financeiro.');
export function creditOrigin(value) {
    const url=new URL(value);
    if(url.protocol!=='https:' || url.origin!==value || url.username || url.password ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))throw blocked();
    return value;
}
export function authorizeCreditOperation(approval,operation,{publicOrigin,apiKey,now=new Date()}) {
    if(operation==='CREATE_LINK')validateCreationScope(approval,now);
    const minimumValid=operation==='CREATE_LINK' || (Number.isSafeInteger(approval?.minimum_centavos) && approval.minimum_centavos>0 &&
        approval.minimum_centavos<=approval.amount_centavos && typeof approval.minimum_evidence==='string' && Boolean(approval.minimum_evidence.trim()));
    if(!approval || approval.phase!=='H4_CREDIT' || approval.operation!==operation || approval.method!=='credit_card' || approval.installments!==1 ||
        !Number.isSafeInteger(approval.amount_centavos) || approval.amount_centavos<1 || !minimumValid ||
        approval.public_origin!==creditOrigin(publicOrigin) || !/^[A-Za-z0-9_-]{1,150}$/.test(approval.handle||'') || !/^[a-f0-9]{64}$/.test(approval.credential_sha256||'') ||
        !Number.isFinite(Date.parse(approval.approved_at)) || Date.parse(approval.approved_at)>now.getTime() ||
        !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at)<=now.getTime() ||
        (apiKey!==undefined && (typeof apiKey!=='string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey) || digest(apiKey)!==approval.credential_sha256)))throw blocked();
    return approval;
}
export function noSecret(value,key) {
    for(let decoded=value;;){
        if(decoded.toLowerCase().includes(key.toLowerCase()))throw blocked();
        const next=decoded.replace(/%([a-f0-9]{2})/ig,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
        if(next===decoded)return;decoded=next;
    }
}
export function createCreditControl({db,captureKey,publicOrigin,now=()=>new Date(),timeoutMs=5000}) {
    creditOrigin(publicOrigin);
    if(!Buffer.isBuffer(captureKey) || captureKey.length!==32)throw blocked();
    const lock=trx=>trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['h4:control']);
    async function pinned(trx=db) {
        if((await trx('pagamentos_eventos').where({event_key:H4.origin}).first())?.payload_filtrado?.origin!==publicOrigin)throw blocked();
    }
    async function pinOrigin() {
        await db.transaction(async trx=>{
            await lock(trx);
            const previous=await trx('pagamentos_eventos').where({event_key:H4.origin}).first();
            if(previous?.payload_filtrado.origin===publicOrigin)return;
            if(await trx('pagamentos_eventos').whereIn('event_key',[H4.command,H4.dispatch]).first())throw blocked();
            const value={origin:publicOrigin};
            if(previous)await trx('pagamentos_eventos').where({id:previous.id}).update({payload_filtrado:value});
            else await trx('pagamentos_eventos').insert({event_key:H4.origin,tipo_evento:'H4_CONFIGURACAO',payload_filtrado:value,status_processamento:'PENDENTE_IDENTIFICACAO'});
        });
    }
    async function original(trx=db) {
        const marker=await trx('pagamentos_eventos').where({event_key:H4.command}).first();
        const payment=marker?.pagamento_id && await trx('pagamentos').where({id:marker.pagamento_id}).first();
        return {marker,payment};
    }
    async function status() {
        return db.transaction(async trx=>{
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const {marker,payment}=await original(trx);
            const released=payment && Boolean(await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id',payment.pedido_id).whereNull('pedidos.deletado_em').first('pedidos.id'));
            return {reserved:Boolean(marker),attempt_status:payment?.status??null,amount_centavos:payment?Number(payment.valor_centavos):null,
                financial_confirmation:Boolean(released && payment.capture_method==='credit_card' && ['PAGA','LIQUIDADA'].includes(payment.status)),kitchen_released:Boolean(released),
                checkout_enabled:(await trx('config_infinitepay').first()).ativo,automatic_retry:false,
                real_link_dispatches:Number((await trx('pagamentos_eventos').where({event_key:H4.dispatch}).count('* as n').first()).n),
                real_check_dispatches:Number((await trx('pagamentos_eventos').where({event_key:H4.check}).count('* as n').first()).n)};
        });
    }
    async function create({apiKey,authorization,confirmed,transport}) {
        if(typeof apiKey!=='string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey))throw blocked();
        const approval=authorizeCreditOperation(authorization,'CREATE_LINK',{publicOrigin,apiKey,now:now()});
        if(confirmed!==true || typeof transport!=='function')throw blocked();
        const client=createInfinitepayClient({now,timeoutMs,checkoutOrigins:['https://checkout.infinitepay.io'],parseCreatedLink:data=>{
            const result=parseObservedCreatedLink(data);noSecret(result.checkoutUrl,apiKey);return result;
        },transport:async(url,init)=>{
            authorizeCreditOperation(approval,'CREATE_LINK',{publicOrigin,apiKey,now:now()});
            await db.transaction(async trx=>{
                await trx.raw('SET LOCAL synchronous_commit=on');await lock(trx);await pinned(trx);
                const {payment}=await original(trx),payload=JSON.parse(init.body);
                const order=payment && await trx('pedidos').where({id:payment.pedido_id}).first('client_request_id');
                if(!payment || payment.status!=='CRIANDO' || payload.order_nsu!==payment.order_nsu || Number(payment.valor_centavos)!==approval.amount_centavos ||
                    order?.client_request_id!==approval.attempt_reference ||
                    init.headers['X-Api-Key']!==apiKey || new URL(payload.redirect_url).origin!==publicOrigin || payload.webhook.url!==publicOrigin+'/pagamentos/infinitepay/webhook')throw blocked();
                await trx('pagamentos_eventos').insert({event_key:H4.dispatch,tipo_evento:'H4_RESERVA_ENVIO_LINKS',pagamento_id:payment.id,status_processamento:'PENDENTE_IDENTIFICACAO'});
            });
            const payload=JSON.parse(init.body);payload.options.payment_methods_enabled=['credit_card'];
            const response=await transport(url,{...init,body:JSON.stringify(payload)});
            let body='',complete=false;
            try{
                body=await readCreditBody(response);complete=true;
            }finally{await observeCredit(db,captureKey,'LINKS',{status:response.status,body,complete},(await original()).payment.id);}
            return new Response(body,{status:response.status,headers:{'Content-Type':'application/json'}});
        }});
        const orchestrator=createPaymentOrchestrator({db,client,now,orderNsuPrefix:'H4-CREDITO',redirectUrl:publicOrigin+'/pagamentos/infinitepay/retorno',webhookUrl:publicOrigin+'/pagamentos/infinitepay/webhook'});
        const reservation=await db.transaction(async trx=>{
            await trx.raw('SET LOCAL synchronous_commit=on');await lock(trx);await pinned(trx);
            if(await trx('pagamentos_eventos').whereIn('event_key',[H4.command,H4.dispatch]).first())return null;
            const config=await trx('config_infinitepay').where({id:1}).forUpdate().first();
            if(config?.ativo!==false || config.assured_installments!==1 || (config.handle && config.handle!==approval.handle))throw blocked();
            let credential=config.credencial_atual_id && await trx('infinitepay_credenciais').where({id:config.credencial_atual_id,handle:approval.handle}).first();
            if(credential && decryptApiKey(credential,approval.handle)!==apiKey)throw blocked();
            if(!credential)[credential]=await trx('infinitepay_credenciais').insert({handle:approval.handle,...encryptApiKey(apiKey,approval.handle)}).returning('*');
            await trx('config_infinitepay').where({id:1}).update({handle:approval.handle,credencial_atual_id:credential.id});
            let method=await trx('metodos_pagamento').where({codigo:'CARTAO_CREDITO'}).first();
            if(method && (method.tipo_financeiro!=='CREDITO' || !method.ativo || method.deletado_em))throw blocked();
            if(!method)[method]=await trx('metodos_pagamento').insert({nome:'H4 Crédito sintético',codigo:'CARTAO_CREDITO',tipo_financeiro:'CREDITO'}).returning('*');
            const amount=(approval.amount_centavos/100).toFixed(2);
            const [order]=await trx('pedidos').insert({nome_cliente:'H4 HOMOLOGACAO CREDITO',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
                metodo_pagamento_id:method.id,valor_total:amount,fluxo_pagamento:'INFINITEPAY'}).returning('*');
            const [size]=await trx('tamanhos_marmitas').insert({nome:'H4 '+randomUUID(),preco_base:amount}).returning('id');
            await trx('itens_pedido').insert({pedido_id:order.id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:amount,subtotal:amount});
            const reserved=await orchestrator.reserveInTransaction({pedidoId:order.id,clientRequestId:approval.attempt_reference},trx);
            await trx('pagamentos_eventos').insert({event_key:H4.command,tipo_evento:'H4_RESERVA_COMANDO_LINKS',pagamento_id:reserved.attempt.id,
                payload_filtrado:sealObservation({request:reserved.payload,approval},captureKey),status_processamento:'PENDENTE_IDENTIFICACAO'});
            return reserved;
        });
        if(reservation)await orchestrator.completeReservation(reservation);
        return status();
    }
    async function checkout() {
        return db.transaction(async trx=>{
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await pinned(trx);
            const {marker,payment}=await original(trx);
            if(!marker || !payment || !['AGUARDANDO','INCERTA'].includes(payment.status) || new Date(payment.valid_until)<=now())throw blocked();
            const saved=openObservation(marker.payload_filtrado,captureKey),order=await trx('pedidos').where({id:payment.pedido_id}).first();
            if(order.fluxo_pagamento!=='INFINITEPAY' || order.liberado_cozinha_em || Number(payment.valor_centavos)!==saved.approval.amount_centavos ||
                (saved.approval.schema_version===2 && order.client_request_id!==saved.approval.attempt_reference) ||
                Math.round(Number(order.valor_total)*100)!==saved.approval.amount_centavos || saved.request.order_nsu!==payment.order_nsu)throw blocked();
            let url=payment.checkout_url;
            if(!url){
                const captures=await trx('pagamentos_eventos').where({pagamento_id:payment.id,tipo_evento:'H4_OBSERVACAO_LINKS'});
                if(captures.length!==1)throw blocked();const observed=openObservation(captures[0].payload_filtrado,captureKey);
                if(observed.status!==200 || observed.complete!==true)throw blocked();url=JSON.parse(observed.body).url;
            }
            url=parseObservedCreatedLink({url}).checkoutUrl;
            const credential=await trx('infinitepay_credenciais').where({id:payment.credencial_id,handle:payment.handle_snapshot}).first();
            noSecret(url,decryptApiKey(credential,payment.handle_snapshot));
            return {url,read_only:true,amount_centavos:Number(payment.valor_centavos),financial_confirmation:false};
        });
    }
    return {pinOrigin,pinned,original,status,create,checkout};
}
