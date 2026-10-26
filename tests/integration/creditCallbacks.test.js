import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreditApp } from '../../scripts/credit/app.js';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { initializeInfinitepayApplication } from '../../src/infinitepayApplication.js';

test('credit preparation exposes only callbacks, strips spoofed proxy identity and never approves payments', async () => {
    let received=0;
    const runtime={async receiveEvent(body){assert.deepEqual(body,{event_type:'created'});received++;},async receiveReturn(){throw Object.assign(new Error(),{statusCode:400});}};
    const app=createCreditApp({runtime,publicOrigin:'https://credit-callbacks.example.invalid'});
    assert.equal(app.get('trust proxy'),false);
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    try{
        for(const path of ['/links','/payment_check','/pedidos','/qz/assinar','/pagamentos/retomar'])assert.equal((await fetch(base+path,{method:'POST'})).status,404);
        assert.equal((await fetch(base+'/pagamentos/infinitepay/webhook')).status,405);
        const response=await fetch(base+'/pagamentos/infinitepay/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'1.2.3.4'},body:'{"event_type":"created"}'});
        assert.equal(response.status,200);assert.equal(received,1);assert.deepEqual(await response.json(),{status:'accepted'});
        assert.equal((await fetch(base+'/pagamentos/infinitepay/retorno')).status,400);
    }finally{await new Promise(resolve=>server.close(resolve));}
});

test('credit callbacks persist and deduplicate a synthetic event with the existing runtime while all processing stays disabled', async () => {
    const fixture=await createTestDatabase(),db=fixture.db;let server,service;
    try{
        await db.migrate.latest();
        const publicOrigin='https://credit-callbacks.example.invalid';
        const env={NODE_ENV:'development',INFINITEPAY_MODE:'homologation',INFINITEPAY_CHECKOUT_ENABLED:'false',DB_HOST:'127.0.0.1',
            DB_NAME:db.client.config.connection.database,INFINITEPAY_DATABASE_NAME:db.client.config.connection.database,
            INFINITEPAY_PUBLIC_ORIGIN:publicOrigin,INFINITEPAY_SUCCESS_URL:publicOrigin+'/pedido/sucesso',
            INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:publicOrigin,ALLOWED_ORIGINS:publicOrigin};
        let financialCalls=0;
        service=await initializeInfinitepayApplication({app:{locals:{}},db,env,transport:async()=>{financialCalls++;throw new Error();}});
        const app=createCreditApp({runtime:service.runtime,publicOrigin});server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        const url='http://127.0.0.1:'+server.address().port+'/pagamentos/infinitepay/webhook';
        const send=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const event={event_type:'created',order_nsu:'SYNTHETIC-CREDIT-PROBE',invoice_slug:'SYNTHETIC-CREDIT-INVOICE'};
        assert.equal((await send(event)).status,200);assert.equal((await send(event)).status,200);
        assert.equal(Number((await db('pagamentos_eventos').count('* as n').first()).n),1);
        assert.equal((await db('pagamentos_eventos').first()).status_processamento,'PENDENTE');
        assert.equal((await send({event_type:'created'})).status,400);
        const fail=query=>{if(query.sql.startsWith('insert into "pagamentos_eventos"'))throw new Error('SYNTHETIC_STORAGE_FAILURE');};
        db.on('query',fail);try{assert.equal((await send({...event,order_nsu:'SYNTHETIC-OTHER'})).status,503);}finally{db.removeListener('query',fail);}
        assert.equal(financialCalls,0);assert.equal(service.status().running,false);assert.equal((await db('config_infinitepay').first()).ativo,false);
        assert.equal(Number((await db('pedidos').count('* as n').first()).n),0);
    }finally{if(server)await new Promise(resolve=>server.close(resolve));await service?.stop();await fixture.close();}
});
