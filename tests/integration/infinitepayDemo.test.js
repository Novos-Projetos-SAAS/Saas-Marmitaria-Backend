import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { initializeInfinitepayApplication } from '../../src/infinitepayApplication.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { prepareDemoProvider, createDemoProvider, DEMO_KEY } from '../../scripts/demo/provider.js';

describe('persistent local demonstration uses the existing financial pipeline',()=>{
    let fixture, db, service, provider, size, savedKey;
    const env={NODE_ENV:'development',INFINITEPAY_MODE:'homologation',INFINITEPAY_DEMO:'local-only',DATABASE_URL:'',
        DB_HOST:'127.0.0.1',DB_PORT:'55439',DB_NAME:'infinitepay_phase1_test',INFINITEPAY_DATABASE_NAME:'infinitepay_phase1_test',
        INFINITEPAY_CHECKOUT_ENABLED:'true',INFINITEPAY_PUBLIC_ORIGIN:'https://localhost:55446',INFINITEPAY_SUCCESS_URL:'https://localhost:55445/pedido/sucesso',
        ALLOWED_ORIGINS:'https://localhost:55445,https://localhost:55446',INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'https://localhost:55445,https://localhost:55446'};
    before(async()=>{
        savedKey=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
        fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();await prepareDemoProvider(db);
        await db('metodos_pagamento').insert([{id:1,nome:'Pix',codigo:'PIX',tipo_financeiro:'PIX'}, {id:3,nome:'Cartão de Crédito',codigo:'CARTAO_CREDITO',tipo_financeiro:'CREDITO'}]);
        [size]=await db('tamanhos_marmitas').insert({nome:'DEMO',preco_base:20}).returning('*');
        const [credential]=await db('infinitepay_credenciais').insert({handle:'demo-sintetica',...encryptApiKey(DEMO_KEY,'demo-sintetica')}).returning('*');
        await db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
        provider=createDemoProvider(db);
        service=await initializeInfinitepayApplication({app:{locals:{}},db,env,transport:provider.transport});
        service.start({intervalMs:60000});await db('config_infinitepay').where({id:1}).update({ativo:true});
    });
    after(async()=>{await service?.stop();await fixture?.close();if(savedKey===undefined)delete process.env.INFINITEPAY_ENCRYPTION_KEY;else process.env.INFINITEPAY_ENCRYPTION_KEY=savedKey;});
    async function reserve(id){
        await db('pedidos').insert({id,nome_cliente:'DEMO SINTETICO',telefone_cliente:'11999999999',tipo_pedido:'Remoto',metodo_entrega:'Retirada',metodo_pagamento_id:1,fluxo_pagamento:'INFINITEPAY',valor_total:20});
        await db('itens_pedido').insert({pedido_id:id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:20,subtotal:20});
        return db.transaction(trx=>service.runtime.reserveCreation(trx,id,randomUUID()));
    }
    test('demo activation refuses a real transport even with an otherwise valid local profile',async()=>{
        await assert.rejects(initializeInfinitepayApplication({app:{locals:{}},db,env}));
    });
    test('pending and approved synthetic links use webhook and independent check, receipt and one outbox delivery',async()=>{
        const reservation=await reserve(901), result=await service.runtime.finishCreation(reservation);
        assert.equal(result.pagamento_status,'AGUARDANDO');assert.ok(result.checkout_url.startsWith('https://localhost:55446/__demo/checkout/'));
        const link=await db('demo_checkout_links').first();
        await service.runtime.receiveEvent(await provider.event(link.token));await service.runtime.processPending();
        assert.equal((await db('pagamentos').where({id:reservation.attempt.id}).first()).status,'AGUARDANDO');
        await provider.approve(link.token,'credit_card');
        for(let i=0;i<3;i++)await service.runtime.receiveEvent(await provider.event(link.token));
        await service.runtime.processPending();
        const payment=await db('pagamentos').where({id:reservation.attempt.id}).first();
        assert.equal(payment.status,'PAGA');assert.equal(payment.capture_method,'credit_card');assert.ok(payment.receipt_url.startsWith('https://localhost:55446/DEMO-'));
        assert.equal(Number((await db('infinitepay_entregas_homologacao').where({pedido_id:901}).count('* as n').first()).n),1);
        await assert.rejects(provider.approve(link.token,'pix'));
    });
    test('lost response persists provider state and reservation across restart without another dispatch',async()=>{
        await provider.setMode('UNCERTAIN');const reservation=await reserve(902);
        assert.equal((await service.runtime.finishCreation(reservation)).pagamento_status,'INCERTA');
        const link=await db('demo_checkout_links').where({order_nsu:reservation.attempt.order_nsu}).first();assert.ok(link);
        const restarted=createDemoProvider(db);await restarted.approve(link.token,'pix');
        await service.runtime.receiveEvent(await restarted.event(link.token));await service.runtime.processPending();
        assert.equal((await db('pagamentos').where({id:reservation.attempt.id}).first()).status,'PAGA');
        assert.equal(Number((await db('demo_checkout_links').count('* as n').first()).n),2);
    });
    test('simulation transport never forwards unknown destinations or non-synthetic credentials',async()=>{
        for(const [url,key]of [['https://evil.invalid/links',DEMO_KEY],['https://api.checkout.infinitepay.io/links','REAL_KEY_REFUSED']])
            await assert.rejects(provider.transport(url,{method:'POST',headers:{'X-Api-Key':key},body:'{}'}));
        assert.equal(Number((await db('demo_checkout_links').count('* as n').first()).n),2);
    });
});
