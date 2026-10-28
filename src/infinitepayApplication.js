import { createInfinitepayClient } from './services/infinitepayClient.js';
import { createInfinitepayCheckClient } from './services/infinitepayCheckClient.js';
import { parseObservedCreatedLink, parseObservedPaymentCheck, parseObservedInfinitepayEvent } from './services/infinitepayObservedContracts.js';
import { createInfinitepayRuntime, startInfinitepayProcessing } from './infinitepayRuntime.js';
import { decryptApiKey } from './utils/infinitepayCredentials.js';
import { providerOrigins } from './config/infinitepayProviderOrigins.js';
import { validateProductionEnvironment } from './config/infinitepayProduction.js';
import { initializeProductionApplication } from './infinitepayProductionApplication.js';

function blocked() {
    return Object.assign(new Error('Ativação indisponível: valide os requisitos do ambiente de homologação.'),
        { code:'INFINITEPAY_ACTIVATION_BLOCKED', statusCode:400, exposeMessage:true });
}
const loopback = value => ['127.0.0.1','localhost','::1'].includes(value);
function origin(value) {
    const url=new URL(value);
    if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.origin !== value) throw blocked();
    return url;
}
export function validateInfinitepayEnvironment(env = process.env) {
    if(env.INFINITEPAY_MODE === 'production') return validateProductionEnvironment(env);
    try {
        if (!env.INFINITEPAY_MODE || env.INFINITEPAY_MODE === 'disabled') {
            if(env.INFINITEPAY_CHECKOUT_ENABLED === 'true') throw blocked();
            return null;
        }
        if(env.INFINITEPAY_MODE !== 'homologation' || env.NODE_ENV !== 'development' ||
            !/^infinitepay_[a-z0-9_]+(?:test|homologacao)$/.test(env.INFINITEPAY_DATABASE_NAME || '') ||
            /^infinitepay_h[123]_/.test(env.INFINITEPAY_DATABASE_NAME)) throw blocked();
        if(env.DATABASE_URL) {
            const db=new URL(env.DATABASE_URL);
            if(!['postgres:','postgresql:'].includes(db.protocol) || !loopback(db.hostname) ||
                db.pathname.slice(1) !== env.INFINITEPAY_DATABASE_NAME || db.search || db.hash) throw blocked();
        } else if(!loopback(env.DB_HOST) || env.DB_NAME !== env.INFINITEPAY_DATABASE_NAME) throw blocked();
        const publicOrigin=origin(env.INFINITEPAY_PUBLIC_ORIGIN).origin;
        const success=new URL(env.INFINITEPAY_SUCCESS_URL);
        origin(success.origin);
        if(success.username || success.password || success.search || success.hash || success.pathname !== '/pedido/sucesso') throw blocked();
        const allowed=(env.INFINITEPAY_ALLOWED_PUBLIC_ORIGINS || '').split(',').filter(Boolean).map(value=>origin(value.trim()).origin);
        if(!allowed.includes(publicOrigin) || !allowed.includes(success.origin) ||
            !(env.ALLOWED_ORIGINS || '').split(',').map(v=>v.trim()).includes(success.origin)) throw blocked();
        return { publicOrigin, successUrl:success.href, database:env.INFINITEPAY_DATABASE_NAME };
    } catch { throw blocked(); }
}

export async function initializeInfinitepayApplication({ app, db, env = process.env, transport = globalThis.fetch, now = () => new Date(),
    productionAuthorization,operationalAdapter }) {
    const config=validateInfinitepayEnvironment(env);
    if(!config) return { start(){},async stop(){},status:()=>({running:false,mode:'disabled'}) };
    if(config.mode==='production') return initializeProductionApplication({app,db,env,config,transport,now,productionAuthorization,operationalAdapter});
    const origins=providerOrigins(env);
    if(origins.demo && (transport === globalThis.fetch || config.publicOrigin !== origins.checkoutOrigin)) throw blocked();
    // Validate the actual connection before issuing any database statement.
    const connection=db.client.config.connection;
    let host=connection?.host, database=connection?.database;
    if(connection?.connectionString) { const url=new URL(connection.connectionString);host=url.hostname;database=url.pathname.slice(1); }
    if(!loopback(host) || database !== config.database) throw blocked();
    const actual=(await db.raw('SELECT current_database() AS name, host(inet_server_addr()) AS address')).rows[0];
    if(actual.name !== config.database || !loopback(actual.address) ||
        !await db.schema.hasTable('infinitepay_entregas_homologacao')) throw blocked();
    let worker, running=false, cycles=0, errors=0;
    async function assertReady(trx=db, proposed) {
        try {
            if(!running || env.INFINITEPAY_CHECKOUT_ENABLED !== 'true') throw blocked();
            const row=proposed ?? await trx('config_infinitepay').where({id:1}).first();
            if(!row?.handle || !row.credencial_atual_id) throw blocked();
            const credential=await trx('infinitepay_credenciais').where({id:row.credencial_atual_id,handle:row.handle,config_id:1}).first();
            if(!credential || !/^[\x21-\x7E]+$/.test(decryptApiKey(credential,row.handle))) throw blocked();
            if(origins.demo && (row.handle !== 'demo-sintetica' || decryptApiKey(credential,row.handle) !== 'SYNTHETIC_INFINITEPAY_DEMO_ONLY')) throw blocked();
            for(const [codigo,tipo_financeiro] of [['PIX','PIX'],['CARTAO_CREDITO','CREDITO']]) {
                if(!await trx('metodos_pagamento').where({codigo,tipo_financeiro,ativo:true}).whereNull('deletado_em').first('id')) throw blocked();
            }
            if(await trx('dados_empresa').where({imprimir_automaticamente:true}).first('id')) throw blocked();
            if(!running || env.INFINITEPAY_CHECKOUT_ENABLED !== 'true') throw blocked();
            return true;
        } catch { throw blocked(); }
    }
    const checkoutOrigins=[origins.checkoutOrigin], receiptOrigins=[origins.receiptOrigin];
    const checkoutClient=createInfinitepayClient({transport,parseCreatedLink:data=>parseObservedCreatedLink(data,{checkoutOrigins}),checkoutOrigins,now});
    const checkClient=createInfinitepayCheckClient({transport,parsePaymentCheck:(data,expected)=>parseObservedPaymentCheck(data,expected,{receiptOrigins}),receiptOrigins});
    const runtime=createInfinitepayRuntime({db,checkoutClient,checkClient,parseEvent:data=>parseObservedInfinitepayEvent(data,{receiptOrigins}),now,environment:env,
        redirectUrl:config.publicOrigin+'/pagamentos/infinitepay/retorno',
        webhookUrl:config.publicOrigin+'/pagamentos/infinitepay/webhook',successUrl:config.successUrl,
        receiptOrigins,
        activationCheck:async trx=>{try{return await assertReady(trx);}catch{return false;}},
        dispatchStateAllowed:()=>running && env.INFINITEPAY_CHECKOUT_ENABLED === 'true',
        deliver:async dto=>{
            // Durable isolated consumer: no Socket.IO, kitchen, printing or external side effect.
            await db('infinitepay_entregas_homologacao').insert({chave_unica:dto.key,pedido_id:dto.pedidoId})
                .onConflict('chave_unica').ignore();
        }});
    app.locals.infinitepayRuntime=runtime;
    const service={runtime,assertReady,
        start(options={}){
            if(worker) return;
            running=true;
            worker=startInfinitepayProcessing(runtime,{...options,onCycle:result=>{cycles++;errors+=result.errors || 0;}});
        },
        async stop(){running=false;const previous=worker;worker=undefined;await previous?.stop();},
        status:()=>({mode:'homologation',running,consumer:'isolated',cycles,errors})};
    app.locals.infinitepayActivation=service;
    return service;
}
