import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {createProductionAuthorizer} from '../../src/services/productionAuthorizer.js';
import {configureProductionProxy} from '../../src/config/infinitepayProduction.js';
import {initializeInfinitepayApplication,validateInfinitepayEnvironment} from '../../src/infinitepayApplication.js';
import {infinitepaySessionCsrf} from '../../src/utils/infinitepaySessionCsrf.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';

describe('historical verification after current credential removal in production composition',{concurrency:false},()=>{
    let fixture,db,env,credential,session,service,previous,orderNsu;
    const secret=randomBytes(32).toString('base64'),origin='https://shop.invalid.test',calls=[];
    before(async()=>{
        fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();env=syntheticProductionEnvironment(testConnection());
        previous=Object.fromEntries(['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(key=>[key,process.env[key]]));
        process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');delete process.env.INFINITEPAY_ENCRYPTION_KEYS;delete process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION;
        await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
        const [role]=await db('niveis_acesso').insert({nome:'admin',descricao:'SYNTHETIC'}).returning('*');
        const [actor]=await db('usuarios').insert({nome:'SYNTHETIC',email:'history@invalid.test',senha_hash:'NONE',nivel_acesso_id:role.id}).returning('*');
        const permission=await db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();
        await db('permissoes_usuarios').insert({usuario_id:actor.id,permissao_id:permission.id});
        const token=jwt.sign({id:actor.id},secret,{expiresIn:'1h'});session={token,origin,csrf:infinitepaySessionCsrf(token,secret)};
        [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-history',...encryptApiKey('SYNTHETIC_HISTORY_KEY','synthetic-history')}).returning('*');
        const [method]=await db('metodos_pagamento').insert({nome:'Synthetic Pix',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
            metodo_pagamento_id:method.id,valor_total:'1.00',fluxo_pagamento:'INFINITEPAY'}).returning('*');
        orderNsu=randomUUID();
        await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:orderNsu,status:'INCERTA',valor_centavos:100,
            valid_until:new Date(),credencial_id:credential.id,handle_snapshot:credential.handle});
        await db('config_infinitepay').where({id:1}).update({ativo:false,handle:null,credencial_atual_id:null});
        Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'false',INFINITEPAY_CHECKOUT_ENABLED:'false'});
    });
    after(async()=>{await service?.stop();await fixture?.close();for(const [key,value]of Object.entries(previous || {})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
    test('a new boot requires an explicit historical grant and only verifies the original charge, never creates or delivers',async()=>{
        const authorizer=createProductionAuthorizer({db,env,sessionSecret:()=>secret}),app=express();configureProductionProxy(app,validateInfinitepayEnvironment(env));
        service=await initializeInfinitepayApplication({app,db,env,productionAuthorization:authorizer.authorize,now:()=>new Date(),
            transport:async(url,init)=>{
                assert.equal(url,'https://api.checkout.infinitepay.io/payment_check');assert.equal(init.headers['X-Api-Key'],'SYNTHETIC_HISTORY_KEY');
                const body=JSON.parse(init.body);assert.equal(body.order_nsu,orderNsu);assert.equal(body.handle,credential.handle);calls.push(body);
                return {status:200,json:async()=>({success:true,paid:true,amount:100,paid_amount:100,installments:1,capture_method:'pix'})};
            }});
        await assert.rejects(service.start({intervalMs:3600000}));
        await authorizer.approve({session,credentialId:credential.id,capabilities:['WORKER','VERIFY_PAYMENT']});
        await service.start({intervalMs:3600000});
        for(let n=0;n<100 && service.status().cycles===0;n++)await new Promise(resolve=>setTimeout(resolve,10));
        await service.runtime.receiveEvent({event_type:'paid',order_nsu:orderNsu,transaction_nsu:'SYNTHETIC-HISTORY-TX',invoice_slug:'SYNTHETIC-HISTORY-SLUG'});
        const result=await service.runtime.processPending();assert.equal(result.errors,0);assert.equal(calls.length,1);
        assert.equal((await db('pagamentos').where({order_nsu:orderNsu}).first()).status,'PAGA');
        assert.equal((await db('outbox_eventos').first()).status,'PENDENTE');
        assert.equal(await service.runtime.checkoutEnabled(),false);
        assert.equal(await authorizer.authorize({operation:'DELIVER_ORDER',database:env.DB_NAME,databaseId:env.INFINITEPAY_DATABASE_ID,
            deploymentId:env.INFINITEPAY_DATABASE_ID,environment:'production',publicOrigin:env.INFINITEPAY_PUBLIC_ORIGIN,destinationId:'unapproved-destination'}),false);
    });
});
