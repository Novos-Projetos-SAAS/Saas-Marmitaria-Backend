import { createInfinitepayClient } from './services/infinitepayClient.js';
import { createInfinitepayCheckClient } from './services/infinitepayCheckClient.js';
import { parseObservedCreatedLink,parseObservedPaymentCheck,parseObservedInfinitepayEvent } from './services/infinitepayObservedContracts.js';
import { createInfinitepayRuntime,startInfinitepayProcessing } from './infinitepayRuntime.js';
import { decryptApiKey } from './utils/infinitepayCredentials.js';
import { assertProductionDatabase,productionBlocked,productionProxyConfigured } from './config/infinitepayProduction.js';
import { timingSafeEqual } from 'node:crypto';

export async function initializeProductionApplication({app,db,env,config,transport,now,productionAuthorization,operationalAdapter}) {
    if(!productionProxyConfigured(app,config)) throw productionBlocked();
    await assertProductionDatabase(db,config);
    for(const table of ['infinitepay_entregas_operacionais','infinitepay_entregas_tentativas'])
        if(!await db.schema.hasTable(table)) throw productionBlocked();
    const context=Object.freeze({database:config.database,databaseId:config.databaseId,publicOrigin:config.publicOrigin,environment:'production',deploymentId:config.databaseId});
    const destinationId=operationalAdapter?.id;
    let worker,running=false,starting,generation=0,cycles=0,errors=0;
    const flag=operation=>({CREATE_LINK:'INFINITEPAY_CHECKOUT_ENABLED',VERIFY_PAYMENT:'INFINITEPAY_VERIFY_ENABLED',
        DELIVER_ORDER:'INFINITEPAY_DELIVERY_ENABLED',WORKER:'INFINITEPAY_WORKER_ENABLED'})[operation];
    async function permitted(operation,{credentialId}={}) {
        if(env[flag(operation)]!=='true' || typeof productionAuthorization!=='function') return false;
        if(operation==='DELIVER_ORDER' && operationalAdapter?.id!==destinationId)return false;
        try {
            await assertProductionDatabase(db,config);
            return await productionAuthorization(Object.freeze({...context,operation,...(credentialId===undefined?{}:{credentialId}),
                ...(operation==='DELIVER_ORDER' ? {destinationId}: {})}))===true && env[flag(operation)]==='true';
        } catch { return false; }
    }
    async function credentials(trx=db,proposed) {
        const row=proposed ?? await trx('config_infinitepay').where({id:1}).first();
        const c=row?.handle && row.credencial_atual_id && await trx('infinitepay_credenciais')
            .where({id:row.credencial_atual_id,handle:row.handle,config_id:1}).first();
        if(!c || !/^[\x21-\x7E]{1,4096}$/.test(decryptApiKey(c,row.handle))) throw productionBlocked();
    }
    const processingAllowed=()=>running && env.INFINITEPAY_WORKER_ENABLED==='true';
    async function canOperate(operation,details) {
        return processingAllowed() && await permitted('WORKER') && await permitted(operation,details) && processingAllowed();
    }
    let consumer;
    if(operationalAdapter) {
        const {createDurableOrderConsumer}=await import('./services/durableOrderConsumer.js');
        const guardedAdapter={id:operationalAdapter.id,supportsIdempotency:operationalAdapter.supportsIdempotency};
        for(const method of ['send','lookupReceipt','verifyReceipt']) {
            if(typeof operationalAdapter[method]!=='function') throw productionBlocked();
            guardedAdapter[method]=async(...args)=>{
                if(method!=='send' && !await canOperate('DELIVER_ORDER')) throw productionBlocked();
                if(!processingAllowed() || operationalAdapter.id!==destinationId || env.INFINITEPAY_DELIVERY_ENABLED!=='true' || args.at(-1)?.signal?.aborted) throw productionBlocked();
                return operationalAdapter[method](...args);
            };
        }
        consumer=createDurableOrderConsumer({db,adapter:guardedAdapter,now,authorizeSend:()=>canOperate('DELIVER_ORDER')});
    }
    async function assertReady(trx=db,proposed) {
        if(!consumer || !await canOperate('CREATE_LINK')) throw productionBlocked();
        await credentials(trx,proposed);
        for(const [codigo,tipo_financeiro] of [['PIX','PIX'],['CARTAO_CREDITO','CREDITO']])
            if(!await trx('metodos_pagamento').where({codigo,tipo_financeiro,ativo:true}).whereNull('deletado_em').first('id')) throw productionBlocked();
        // Physical operation has not been certified; this preparation cannot enable automatic printing.
        if(await trx('dados_empresa').where({imprimir_automaticamente:true}).first('id')) throw productionBlocked();
        if(!await canOperate('CREATE_LINK')) throw productionBlocked();
        return true;
    }
    const guardedTransport=async(url,init)=>{
        const operation=url==='https://api.checkout.infinitepay.io/links'?'CREATE_LINK':
            url==='https://api.checkout.infinitepay.io/payment_check'?'VERIFY_PAYMENT':null;
        if(!operation || init?.method!=='POST' || !processingAllowed()) throw productionBlocked();
        let request;
        try{request=JSON.parse(init.body);}catch{throw productionBlocked();}
        if(typeof request?.order_nsu!=='string' || !request.order_nsu.trim() || request.order_nsu!==request.order_nsu.trim())throw productionBlocked();
        const attempt=await db('pagamentos').where({order_nsu:request.order_nsu,provedor:'INFINITEPAY'}).first();
        const stored=attempt && await db('infinitepay_credenciais').where({id:attempt.credencial_id,handle:attempt.handle_snapshot,config_id:1}).first();
        if(!stored || (operation==='VERIFY_PAYMENT' && request.handle!==attempt.handle_snapshot) || typeof init.headers?.['X-Api-Key']!=='string')throw productionBlocked();
        const expected=Buffer.from(decryptApiKey(stored,attempt.handle_snapshot)),supplied=Buffer.from(init.headers['X-Api-Key']);
        try{if(expected.length!==supplied.length || !timingSafeEqual(expected,supplied))throw productionBlocked();}
        finally{expected.fill(0);supplied.fill(0);}
        if(!await canOperate(operation,{credentialId:attempt.credencial_id}))throw productionBlocked();
        if(!processingAllowed() || env[flag(operation)]!=='true' || init.signal?.aborted) throw productionBlocked();
        return transport(url,init);
    };
    const checkoutOrigins=['https://checkout.infinitepay.io'],receiptOrigins=['https://recibo.infinitepay.io'];
    const base=createInfinitepayRuntime({db,now,environment:env,receiptOrigins,
        checkoutClient:createInfinitepayClient({transport:guardedTransport,now,checkoutOrigins,parseCreatedLink:parseObservedCreatedLink}),
        checkClient:createInfinitepayCheckClient({transport:guardedTransport,receiptOrigins,parsePaymentCheck:parseObservedPaymentCheck}),
        parseEvent:parseObservedInfinitepayEvent,redirectUrl:config.publicOrigin+'/pagamentos/infinitepay/retorno',
        webhookUrl:config.publicOrigin+'/pagamentos/infinitepay/webhook',successUrl:config.successUrl,
        activationCheck:async trx=>{try{return await assertReady(trx);}catch{return false;}},
        dispatchStateAllowed:()=>running && env.INFINITEPAY_CHECKOUT_ENABLED==='true',
        deliver:async dto=>{
            if(!consumer || !await canOperate('DELIVER_ORDER')) throw productionBlocked();
            return consumer.deliver(dto);
        }});
    const runtime={...base,async processPending({limit=25}={}) {
        if(!processingAllowed()) return {events:0,deliveries:0,errors:0};
        const processEvents=await canOperate('VERIFY_PAYMENT'),processDeliveries=Boolean(consumer) && await canOperate('DELIVER_ORDER');
        if(!processEvents && !processDeliveries) return {events:0,deliveries:0,errors:0};
        return base.processPending({limit,processEvents,processDeliveries});
    }};
    async function startWorker(options,epoch) {
        if(!await permitted('WORKER') || (!await permitted('VERIFY_PAYMENT') && !(consumer && await permitted('DELIVER_ORDER')))) throw productionBlocked();
        await credentials();
        if(epoch!==generation || env.INFINITEPAY_WORKER_ENABLED!=='true') throw productionBlocked();
        worker=startInfinitepayProcessing(runtime,{...options,onCycle:r=>{cycles++;errors+=r.errors || 0;}});
        running=true;
    }
    const service={runtime,assertReady,
        async start(options={}) {
            if(env.INFINITEPAY_WORKER_ENABLED!=='true' || worker) return;
            if(starting) return starting;
            starting=startWorker(options,generation);
            try{await starting;}finally{starting=undefined;}
        },
        async stop(){generation++;running=false;await starting?.catch(()=>{});const previous=worker;worker=undefined;await previous?.stop();},
        status:()=>({mode:'production',prepared:true,running,consumer:consumer?'operational-adapter':'unconfigured',cycles,errors})};
    app.locals.infinitepayRuntime=runtime;app.locals.infinitepayActivation=service;
    return service;
}
