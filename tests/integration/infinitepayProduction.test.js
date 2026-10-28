import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import express from 'express';
import { createServer,request } from 'node:http';
import { createTestDatabase,testConnection } from '../helpers/testDatabase.js';
import { syntheticProductionEnvironment } from '../helpers/productionEnvironment.js';
import { initializeInfinitepayApplication,validateInfinitepayEnvironment } from '../../src/infinitepayApplication.js';
import { configureProductionProxy } from '../../src/config/infinitepayProduction.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';

async function fixture({credential=true}={}) {
    const f=await createTestDatabase(),env=syntheticProductionEnvironment(testConnection());
    await f.db.migrate.latest();
    await f.db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
    const app=express();configureProductionProxy(app,validateInfinitepayEnvironment(env));
    const old=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
    if(credential) {
        const [c]=await f.db('infinitepay_credenciais').insert({handle:'synthetic-production',...encryptApiKey('SYNTHETIC_PRODUCTION_KEY','synthetic-production')}).returning('*');
        await f.db('config_infinitepay').where({id:1}).update({handle:c.handle,credencial_atual_id:c.id});
    }
    let requests=0;const transport=async()=>{requests++;throw new Error('SYNTHETIC_TRANSPORT_MUST_STAY_CLOSED');};
    const compose=extra=>initializeInfinitepayApplication({app,db:f.db,env,transport,...extra});
    return {...f,env,app,compose,requests:()=>requests,async close(){if(old===undefined)delete process.env.INFINITEPAY_ENCRYPTION_KEY;else process.env.INFINITEPAY_ENCRYPTION_KEY=old;await f.close();}};
}
test('prepared production does not start worker, create, verify or deliver by default',async()=>{
    const f=await fixture();let s;
    try{s=await f.compose();await s.start();assert.equal(s.status().mode,'production');assert.equal(s.status().running,false);
        assert.equal(await s.runtime.checkoutEnabled(),false);assert.deepEqual(await s.runtime.processPending(),{events:0,deliveries:0,errors:0});
        assert.equal(f.requests(),0);assert.equal((await f.db('config_infinitepay').first()).ativo,false);
    }finally{await s?.stop();await f.close();}
});
test('worker flag and NODE_ENV production cannot authorize financial processing',async()=>{
    const f=await fixture();let s;
    try{Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true',INFINITEPAY_CHECKOUT_ENABLED:'true'});
        s=await f.compose();await assert.rejects(s.start());assert.equal(s.status().running,false);assert.equal(await s.runtime.checkoutEnabled(),false);assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('wrong persistent deployment identity or unconfigured environment blocks composition',async()=>{
    const f=await fixture();
    try{await f.db('infinitepay_identidade_ambiente').where({id:1}).update({ambiente:'NAO_CONFIGURADO'});await assert.rejects(f.compose());
        await f.db('infinitepay_identidade_ambiente').where({id:1}).update({ambiente:'PRODUCAO'});
        f.env.INFINITEPAY_DATABASE_ID='be8743cc-985d-486f-a87b-0d7d6d45cc01';await assert.rejects(f.compose());assert.equal(f.requests(),0);
    }finally{await f.close();}
});
test('missing or undecipherable credential blocks explicitly requested worker',async()=>{
    const f=await fixture({credential:false});let s;
    try{Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        s=await f.compose({productionAuthorization:async()=>true});await assert.rejects(s.start());assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('an incorrect encryption key blocks worker activation without sending credentials anywhere',async()=>{
    const f=await fixture();let s;
    try{Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
        s=await f.compose({productionAuthorization:async()=>true});await assert.rejects(s.start());assert.equal(s.status().running,false);assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('stop during pending worker authorization prevents starting any financial cycle',async()=>{
    const f=await fixture();let s,release,arrived;const authorizationPending=new Promise(r=>release=r),entered=new Promise(r=>arrived=r);
    try{Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        s=await f.compose({productionAuthorization:async context=>{if(context.operation==='WORKER'){arrived();await authorizationPending;}return true;}});
        const starting=s.start().then(()=>false,()=>true);await entered;const stopping=s.stop();release();
        assert.equal(await starting,true);await stopping;assert.equal(s.status().running,false);assert.equal(s.status().cycles,0);assert.equal(f.requests(),0);
    }finally{release?.();await s?.stop();await f.close();}
});
async function syntheticOrder(db,{paid=false}={}) {
    for(const [id,codigo,tipo_financeiro]of [[91,'PIX','PIX'],[92,'CARTAO_CREDITO','CREDITO']])
        await db('metodos_pagamento').insert({id,nome:'SYNTHETIC '+codigo,codigo,tipo_financeiro}).onConflict('id').ignore();
    const [size]=await db('tamanhos_marmitas').insert({nome:'SYNTHETIC '+randomUUID(),preco_base:20}).returning('*');
    const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
        metodo_pagamento_id:91,fluxo_pagamento:'INFINITEPAY',valor_total:20,...(paid?{liberado_cozinha_em:new Date()}: {})}).returning('*');
    await db('itens_pedido').insert({pedido_id:order.id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:20,subtotal:20});
    if(paid) {
        const c=await db('infinitepay_credenciais').first();
        await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-'+order.id,status:'PAGA',valor_centavos:2000,
            valor_base_provider_centavos:2000,valor_pago_provider_centavos:2100,provider_verified_at:new Date(),pago_em:new Date(),
            credencial_id:c.id,handle_snapshot:c.handle,transaction_nsu:'SYNTHETIC-TXN-'+order.id,invoice_slug:'SYNTHETIC-SLUG-'+order.id,
            capture_method:'credit_card',installments:1,valid_until:'2050-01-01T00:00:00Z'});
    }
    return order;
}
function syntheticAdapter(onSend=()=>{}) {
    return {id:'synthetic-production-destination',supportsIdempotency:true,
        async send(dto){onSend();return {acknowledged:true,key:dto.key,pedidoId:dto.pedidoId,destination:this.id,receiptId:'SYNTHETIC-RECEIPT'};},
        async lookupReceipt(){return null;},async verifyReceipt(){return true;}};
}
test('delivery-only production worker recovers its outbox without payment_check or a second logical effect',async()=>{
    const f=await fixture();let service,restarted,sends=0;const authorized=[];
    try {
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'true'});
        const order=await syntheticOrder(f.db,{paid:true}),key='pedido_liberado:'+order.id;
        await f.db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:key});
        await f.db('pagamentos_eventos').insert({event_key:'SYNTHETIC-PENDING-PAID',tipo_evento:'paid',status_processamento:'PENDENTE',
            payload_filtrado:{version:1,type:'paid',orderNsu:'SYNTHETIC-'+order.id}});
        const options={operationalAdapter:syntheticAdapter(()=>sends++),productionAuthorization:async context=>{authorized.push(context);return true;}};
        service=await f.compose(options);await service.start({intervalMs:60000});
        for(let n=0;n<100 && (await f.db('outbox_eventos').first()).status!=='CONCLUIDO';n++)await new Promise(r=>setTimeout(r,10));
        await service.stop();assert.equal((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal(sends,1);
        assert.equal((await f.db('pagamentos_eventos').where({event_key:'SYNTHETIC-PENDING-PAID'}).first()).tentativas,0);
        await f.db('outbox_eventos').where({chave_unica:key}).update({status:'PENDENTE',processado_em:null});
        restarted=await f.compose(options);await restarted.start({intervalMs:60000});
        for(let n=0;n<100 && (await f.db('outbox_eventos').first()).status!=='CONCLUIDO';n++)await new Promise(r=>setTimeout(r,10));
        await restarted.stop();assert.equal((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal(sends,1);assert.equal(f.requests(),0);
        assert.ok(authorized.every(c=>c.databaseId===f.env.INFINITEPAY_DATABASE_ID && ['WORKER','DELIVER_ORDER'].includes(c.operation)));
    } finally {await service?.stop();await restarted?.stop();await f.close();}
});
test('authorized synthetic checkout timeout preserves the reservation and never repeats links on recovery',async()=>{
    const f=await fixture();let service,calls=0;
    try {
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true',INFINITEPAY_CHECKOUT_ENABLED:'true'});
        const order=await syntheticOrder(f.db),requestId=randomUUID();await f.db('config_infinitepay').where({id:1}).update({ativo:true});
        service=await f.compose({operationalAdapter:syntheticAdapter(),productionAuthorization:async()=>true,
            transport:async(url,init)=>{assert.ok(url.endsWith('/links'));assert.equal(init.headers['X-Api-Key'],'SYNTHETIC_PRODUCTION_KEY');calls++;throw new Error('SYNTHETIC_NETWORK_LOSS');}});
        await service.start({intervalMs:60000});assert.equal(await service.runtime.checkoutEnabled(),true);
        const reservation=await f.db.transaction(t=>service.runtime.reserveCreation(t,order.id,requestId));
        assert.equal((await service.runtime.finishCreation(reservation)).pagamento_status,'INCERTA');
        assert.equal((await service.runtime.resume(order.id,{client_request_id:requestId})).pagamento_status,'INCERTA');
        assert.equal(calls,1);assert.equal((await f.db('pedidos').where({id:order.id}).first()).liberado_cozinha_em,null);
        assert.equal(Number((await f.db('outbox_eventos').count('* as n').first()).n),0);
        assert.equal(Number((await f.db('pagamentos').count('* as n').first()).n),1);
    } finally{await service?.stop();await f.close();}
});
test('repeated paid and settled signals cannot confirm payment while production processing is unauthorized',async()=>{
    const f=await fixture();let s;
    try{s=await f.compose();const order=await syntheticOrder(f.db),c=await f.db('infinitepay_credenciais').first();
        await f.db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-PENDING',status:'INCERTA',valor_centavos:2000,
            valid_until:'2050-01-01T00:00:00Z',credencial_id:c.id,handle_snapshot:c.handle});
        const event={event_type:'paid',order_nsu:'SYNTHETIC-PENDING',transaction_nsu:'SYNTHETIC-TXN',invoice_slug:'SYNTHETIC-SLUG'};
        const a=await s.runtime.receiveEvent(event),b=await s.runtime.receiveEvent(event);assert.equal(a.eventId,b.eventId);
        await s.runtime.receiveEvent({...event,event_type:'settled'});await s.start();await s.runtime.processPending();
        assert.equal((await f.db('pagamentos').first()).status,'INCERTA');assert.equal(f.requests(),0);
        assert.equal(Number((await f.db('outbox_eventos').count('* as n').first()).n),0);
        assert.deepEqual((await f.db('pagamentos_eventos').select('tentativas')).map(r=>r.tentativas),[0,0]);
    }finally{await s?.stop();await f.close();}
});
test('revoking worker flag after startup blocks later verification instead of making an unexpected external query',async()=>{
    const f=await fixture();let s;
    try {
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        s=await f.compose({productionAuthorization:async()=>true});await s.start({intervalMs:60000});
        for(let n=0;n<100 && s.status().cycles===0;n++)await new Promise(r=>setTimeout(r,10));
        f.env.INFINITEPAY_WORKER_ENABLED='false';
        const order=await syntheticOrder(f.db),c=await f.db('infinitepay_credenciais').first();
        await f.db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-REVOKED',status:'INCERTA',valor_centavos:2000,
            valid_until:'2050-01-01T00:00:00Z',credencial_id:c.id,handle_snapshot:c.handle});
        await s.runtime.receiveEvent({event_type:'paid',order_nsu:'SYNTHETIC-REVOKED',transaction_nsu:'SYNTHETIC-TXN',invoice_slug:'SYNTHETIC-SLUG'});
        assert.deepEqual(await s.runtime.processPending(),{events:0,deliveries:0,errors:0});assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('revoking delivery while its durable claim is created prevents the adapter from sending',async()=>{
    const f=await fixture();let s,sends=0;
    const revoke=query=>{if(/^insert into/.test(query.sql) && query.sql.includes('infinitepay_entregas_operacionais'))f.env.INFINITEPAY_DELIVERY_ENABLED='false';};
    try {
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'true'});
        const order=await syntheticOrder(f.db,{paid:true});await f.db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:'pedido_liberado:'+order.id});
        f.db.on('query',revoke);s=await f.compose({productionAuthorization:async()=>true,operationalAdapter:syntheticAdapter(()=>sends++)});
        await s.start({intervalMs:60000});
        for(let n=0;n<100 && s.status().cycles===0;n++)await new Promise(r=>setTimeout(r,10));
        await s.stop();assert.equal(sends,0);assert.notEqual((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal(f.requests(),0);
    }finally{f.db.removeListener('query',revoke);await s?.stop();await f.close();}
});
test('slow final delivery authorization cannot send after its ownership lease expires',async()=>{
    const f=await fixture();let s,sends=0,instant=new Date();
    try {
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'true'});
        const order=await syntheticOrder(f.db,{paid:true});await f.db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:'pedido_liberado:'+order.id});
        s=await f.compose({now:()=>instant,operationalAdapter:syntheticAdapter(()=>sends++),productionAuthorization:async context=>{
            if(context.operation==='DELIVER_ORDER' && await f.db('infinitepay_entregas_operacionais').where({status:'ENVIANDO'}).first())instant=new Date(instant.getTime()+31000);
            return true;
        }});
        await s.start({intervalMs:60000});for(let n=0;n<100 && s.status().cycles===0;n++)await new Promise(r=>setTimeout(r,10));
        await s.stop();assert.equal(sends,0);assert.notEqual((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('invalid worker options never leave production marked running',async()=>{
    const f=await fixture();let s;
    try{Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        s=await f.compose({productionAuthorization:async()=>true});await assert.rejects(s.start({intervalMs:0}));
        assert.equal(s.status().running,false);assert.equal(f.requests(),0);
    }finally{await s?.stop();await f.close();}
});
test('financial timeout aborts dispatch even when its final authorizer resolves late',async()=>{
    const f=await fixture();let s,slow=false,checks=0,dispatches=0,release,entered;
    const waiting=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
    try{
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        s=await f.compose({productionAuthorization:async context=>{
            if(slow && context.operation==='VERIFY_PAYMENT' && ++checks===2){entered();await pending;}return true;
        },transport:async()=>{dispatches++;return {status:200,json:async()=>({paid:true,amount:2000,paid_amount:2100,installments:1,capture_method:'credit_card'})};}});
        await s.start({intervalMs:60000});for(let n=0;n<100 && s.status().cycles===0;n++)await new Promise(r=>setTimeout(r,10));
        const order=await syntheticOrder(f.db),c=await f.db('infinitepay_credenciais').first();
        await f.db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-LATE',status:'INCERTA',valor_centavos:2000,
            valid_until:'2050-01-01T00:00:00Z',credencial_id:c.id,handle_snapshot:c.handle});
        await s.runtime.receiveEvent({event_type:'paid',order_nsu:'SYNTHETIC-LATE',transaction_nsu:'SYNTHETIC-TXN',invoice_slug:'SYNTHETIC-SLUG'});
        slow=true;const processing=s.runtime.processPending();await waiting;
        await processing;release();await new Promise(r=>setTimeout(r,20));
        assert.equal(dispatches,0);assert.equal((await f.db('pagamentos').first()).status,'INCERTA');
    }finally{release?.();await s?.stop();await f.close();}
});
test('production composition requires proxy installed before route mounting',async()=>{
    const f=await fixture();try{await assert.rejects(f.compose({app:{locals:{}}}));assert.equal(f.requests(),0);}finally{await f.close();}
});
test('production proxy rejects direct spoofing and ambiguous forwarded chains without disabling rate limiting',async()=>{
    const probe=(url,headers)=>new Promise((resolve,reject)=>{
        const req=request(url,{headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});
        req.on('error',reject);req.end();
    });
    for(const trusted of [false,true]) {
        const env=syntheticProductionEnvironment();env.INFINITEPAY_TRUSTED_PROXY_IPS=trusted?'127.0.0.1':'127.0.0.2';
        const app=express();configureProductionProxy(app,validateInfinitepayEnvironment(env));
        app.get('/probe',(req,res)=>res.json({ip:req.ip,secure:req.secure}));const server=createServer(app);
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        try{const url='http://127.0.0.1:'+server.address().port+'/probe';const headers={Host:'backend.invalid.test','X-Forwarded-Proto':'https','X-Forwarded-For':'203.0.113.7'};
            const r=await probe(url,headers);assert.equal(r.status,trusted?200:403);
            if(trusted)assert.deepEqual(r.body,{ip:'203.0.113.7',secure:true});
            for(const extra of [{'X-Forwarded-For':'203.0.113.7, 198.51.100.1'},{'X-Forwarded-Proto':'http'},{Host:'other.invalid.test'},{Forwarded:'for=203.0.113.7'}])
                assert.equal((await probe(url,{...headers,...extra})).status,403);
        }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    }
});
