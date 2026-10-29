import {describe,test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {initializeInfinitepayApplication,validateInfinitepayEnvironment} from '../../src/infinitepayApplication.js';
import {configureProductionProxy} from '../../src/config/infinitepayProduction.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import {createPaymentOutboxService} from '../../src/services/paymentOutboxService.js';

describe('supervised recovery acknowledges the original durable outbox without another send', {concurrency:false},()=>{
    let fixture,db,env,service,method,previousEncryption,sends=0,lookups=0,mode='valid',authorized=true;
    const destination='synthetic-recovery-destination';
    before(async()=>{
        fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();env=syntheticProductionEnvironment(testConnection());
        await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
        previousEncryption=Object.fromEntries(['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION']
            .map(key=>[key,process.env[key]]));
        delete process.env.INFINITEPAY_ENCRYPTION_KEYS;
        process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION='1';
        process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
        const [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-recovery',...encryptApiKey('SYNTHETIC_KEY','synthetic-recovery')}).returning('*');
        await db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
        [method]=await db('metodos_pagamento').insert({nome:'Synthetic Recovery Pix',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        const app=express();configureProductionProxy(app,validateInfinitepayEnvironment(env));
        const receipt=dto=>({acknowledged:true,key:dto.key,pedidoId:dto.pedidoId,destination,receiptId:'available:synthetic-'+dto.id});
        service=await initializeInfinitepayApplication({app,db,env,
            transport:async()=>{throw new Error('REAL_FINANCIAL_TRANSPORT_FORBIDDEN');},
            productionAuthorization:async()=>authorized,
            operationalAdapter:{id:destination,supportsIdempotency:true,
                async send(){sends++;throw new Error('RECOVERY_MUST_NEVER_SEND');},
                async lookupReceipt(dto){lookups++;if(mode==='missing')return null;if(mode==='revoked')env.INFINITEPAY_DELIVERY_ENABLED='false';return receipt(dto);},
                async verifyReceipt(candidate,dto){return mode!=='invalid' && candidate.receiptId===receipt(dto).receiptId;}}});
        Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'true'});
        await service.start({intervalMs:3600000});
    });
    after(async()=>{await service?.stop();for(const [key,value]of Object.entries(previousEncryption || {})){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
    }await fixture?.close();});
    async function uncertain({outboxStatus='ERRO',locked=false}={}) {
        const instant=new Date();
        const [order]=await db('pedidos').insert({nome_cliente:'Synthetic',telefone_cliente:'00000000000',tipo_pedido:'Remoto',
            metodo_entrega:'Retirada',metodo_pagamento_id:method.id,valor_total:20,fluxo_pagamento:'INFINITEPAY',liberado_cozinha_em:instant}).returning('*');
        const [payment]=await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:randomUUID(),status:'PAGA',valor_centavos:2000,
            valor_base_provider_centavos:2000,valor_pago_provider_centavos:2000,provider_verified_at:instant,pago_em:instant,transaction_nsu:'SYNTHETIC-TXN-'+order.id,
            invoice_slug:'SYNTHETIC-SLUG-'+order.id,capture_method:'pix',installments:1,valid_until:'2050-01-01T00:00:00Z'}).returning('*');
        const key='pedido_liberado:'+order.id;
        const [outbox]=await db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:key,status:outboxStatus,tentativas:5,
            payload_reduzido:{synthetic:'PRESERVE_PAYLOAD'},...(locked?{locked_by:randomUUID(),locked_until:new Date(Date.now()+60000)}:{})}).returning('*');
        await db('infinitepay_entregas_operacionais').insert({chave_unica:key,outbox_id:outbox.id,pedido_id:order.id,destino:destination,status:'INCERTA',
            tentativas:1,ultimo_erro:'DELIVERY_LEASE_LOST'});
        const [attempt]=await db('infinitepay_entregas_tentativas').insert({chave_unica:key,numero:1,token:randomUUID(),operacao:'ENVIO',status:'INCERTA',
            ultimo_erro:'DELIVERY_LEASE_LOST',finalizado_em:instant}).returning('*');
        return {order,payment,outbox,attempt,dto:{id:outbox.id,pedidoId:order.id,tipo:'PEDIDO_LIBERADO',key}};
    }
    test('an exhausted outbox recovers only its persisted receipt and preserves all financial data and retry history',async()=>{
        const f=await uncertain();
        const result=await service.recoverDelivery(f.outbox.id);
        assert.deepEqual(result,{outbox_id:f.outbox.id,pedido_id:f.order.id,status:'CONCLUIDO'});
        const outbox=await db('outbox_eventos').where({id:f.outbox.id}).first();
        assert.equal(outbox.status,'CONCLUIDO');assert.equal(outbox.tentativas,5);assert.deepEqual(outbox.payload_reduzido,f.outbox.payload_reduzido);
        assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);
        assert.deepEqual(await db('pedidos').where({id:f.order.id}).first(),f.order);
        assert.deepEqual(await db('infinitepay_entregas_tentativas').where({id:f.attempt.id}).first(),f.attempt);
        const delivery=await db('infinitepay_entregas_operacionais').where({chave_unica:f.dto.key}).first();
        assert.equal(delivery.status,'RECEBIDA');assert.equal(delivery.tentativas,2);
        assert.equal(sends,0);
        const before=await db('infinitepay_entregas_tentativas').where({chave_unica:f.dto.key}).orderBy('numero');
        assert.deepEqual(await service.recoverDelivery(f.outbox.id),result);
        assert.deepEqual(await db('infinitepay_entregas_tentativas').where({chave_unica:f.dto.key}).orderBy('numero'),before);
    });
    test('concurrent recovery calls converge on one original receipt without a new send or budget reset',async()=>{
        const f=await uncertain();const beforeLookups=lookups;
        const [first,second]=await Promise.all([service.recoverDelivery(f.outbox.id),service.recoverDelivery(f.outbox.id)]);
        assert.deepEqual(first,second);assert.ok(lookups>beforeLookups);assert.equal(sends,0);
        assert.equal((await db('infinitepay_entregas_operacionais').where({chave_unica:f.dto.key}).first()).tentativas,2);
        assert.equal((await db('outbox_eventos').where({id:f.outbox.id}).first()).tentativas,5);
    });
    test('missing or invalid receipts remain uncertain and cannot fall back to another send',async()=>{
        for(const behavior of ['missing','invalid']) {
            mode=behavior;const f=await uncertain();
            await assert.rejects(service.recoverDelivery(f.outbox.id));
            assert.equal((await db('outbox_eventos').where({id:f.outbox.id}).first()).status,'ERRO');
            assert.equal((await db('infinitepay_entregas_operacionais').where({chave_unica:f.dto.key}).first()).status,'INCERTA');
            assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);assert.equal(sends,0);
        }
        mode='valid';
    });
    test('active outbox lease, absent ledger and wrong destination cannot be recovered',async()=>{
        const busy=await uncertain({outboxStatus:'PROCESSANDO',locked:true});const initial=lookups;
        await assert.rejects(service.recoverDelivery(busy.outbox.id));assert.equal(lookups,initial);
        assert.deepEqual(await db('outbox_eventos').where({id:busy.outbox.id}).first(),busy.outbox);
        const missing=await uncertain();await db('infinitepay_entregas_tentativas').where({chave_unica:missing.dto.key}).del();
        await db('infinitepay_entregas_operacionais').where({chave_unica:missing.dto.key}).del();
        await assert.rejects(service.recoverDelivery(missing.outbox.id));
        const wrong=await uncertain();await db('infinitepay_entregas_operacionais').where({chave_unica:wrong.dto.key}).update({destino:'other-destination'});
        await assert.rejects(service.recoverDelivery(wrong.outbox.id));assert.equal(sends,0);
    });
    test('ackRecovered requires an exact received ledger and refuses forged receipt, binding or active lease',async()=>{
        const f=await uncertain(),outbox=createPaymentOutboxService({db,deliver:async()=>assert.fail('must not dispatch')});
        const receipt={acknowledged:true,key:f.dto.key,pedidoId:f.order.id,destination,receiptId:'existing-receipt'};
        await assert.rejects(outbox.ackRecovered(f.dto,receipt));
        await db('infinitepay_entregas_operacionais').where({chave_unica:f.dto.key}).update({status:'RECEBIDA',receipt_id:receipt.receiptId,recebido_em:new Date()});
        for(const forged of [{...receipt,key:'other'},{...receipt,destination:'wrong'},{...receipt,receiptId:'forged'},{...receipt,pedidoId:f.order.id+1}])
            await assert.rejects(outbox.ackRecovered(f.dto,forged));
        await db('outbox_eventos').where({id:f.outbox.id}).update({status:'PROCESSANDO',locked_by:randomUUID(),locked_until:new Date(Date.now()+60000)});
        await assert.rejects(outbox.ackRecovered(f.dto,receipt));
        await db('outbox_eventos').where({id:f.outbox.id}).update({locked_until:new Date(Date.now()-60000)});
        await outbox.ackRecovered(f.dto,receipt);
        const saved=await db('outbox_eventos').where({id:f.outbox.id}).first();assert.equal(saved.status,'CONCLUIDO');assert.equal(saved.tentativas,5);
        assert.deepEqual(await outbox.ackRecovered(f.dto,receipt),f.dto);
    });
    test('worker, delivery flag and capability must stay authorized through recovery',async()=>{
        const f=await uncertain();authorized=false;await assert.rejects(service.recoverDelivery(f.outbox.id));authorized=true;
        env.INFINITEPAY_DELIVERY_ENABLED='false';await assert.rejects(service.recoverDelivery(f.outbox.id));env.INFINITEPAY_DELIVERY_ENABLED='true';
        mode='revoked';await assert.rejects(service.recoverDelivery(f.outbox.id));mode='valid';env.INFINITEPAY_DELIVERY_ENABLED='true';
        assert.equal((await db('outbox_eventos').where({id:f.outbox.id}).first()).status,'ERRO');
        await service.stop();await assert.rejects(service.recoverDelivery(f.outbox.id));assert.equal(sends,0);
    });
});
