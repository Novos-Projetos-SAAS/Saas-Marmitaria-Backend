import {test,beforeEach,afterEach,describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from '../helpers/testDatabase.js';
import {createDurableOrderConsumer} from '../../src/services/durableOrderConsumer.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

describe('authenticated synthetic operational destination',{concurrency:false},()=>{
let f,db,secret,create,mode,adapter,method;
beforeEach(async()=>{
    f=await createTestDatabase();db=f.db;await db.migrate.latest();secret=randomBytes(32);mode='success';
    await db.schema.createTable('infinitepay_destino_sintetico',t=>{
        t.text('chave_unica').primary();t.string('destino',80).notNullable();t.jsonb('envelope').notNullable();
        t.string('payload_hash',64).notNullable();t.uuid('receipt_id').notNullable().unique();
        t.timestamp('recebido_em',{useTz:true}).notNullable();t.string('assinatura',64).notNullable();
    });
    [method]=await db('metodos_pagamento').insert({nome:'SYNTHETIC PIX',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
    ({createSyntheticOrderDestination:create}=await import('../../src/homologation/syntheticOrderDestination.js'));
    adapter=await create({db,secret,behavior:()=>mode});
});
afterEach(async()=>{await f?.close();});
async function order(status='PAGA') {
    const now=new Date();const [p]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
        metodo_pagamento_id:method.id,valor_total:20,fluxo_pagamento:'INFINITEPAY',...(status==='PAGA'?{liberado_cozinha_em:now}:{})}).returning('*');
    await db('pagamentos').insert({pedido_id:p.id,tentativa_numero:1,order_nsu:'SYNTHETIC-'+p.id,status,valor_centavos:2000,valid_until:'2050-01-01T00:00:00Z',
        ...(status==='PAGA'?{provider_verified_at:now,pago_em:now,valor_base_provider_centavos:2000,transaction_nsu:'SYNTHETIC-TXN-'+p.id,invoice_slug:'SYNTHETIC-SLUG-'+p.id,capture_method:'pix'}:{})});
    const [out]=await db('outbox_eventos').insert({pedido_id:p.id,tipo:'PEDIDO_LIBERADO',chave_unica:'pedido_liberado:'+p.id}).returning('*');
    return {id:out.id,pedidoId:p.id,tipo:out.tipo,key:out.chave_unica};
}
const consumer=()=>createDurableOrderConsumer({db,adapter,leaseMs:1000,timeoutMs:100});
test('synthetic destination durably confirms receipt, never physical printing',async()=>{
    const dto=await order(),receipt=await consumer().deliver(dto);assert.equal(receipt.acknowledged,true);
    const observed=await adapter.lookupReceipt(dto);assert.equal(observed.stage,'RECEIVED');assert.equal(observed.printed,false);
    assert.equal(await adapter.verifyReceipt(observed,dto),true);
    assert.equal((await db('infinitepay_entregas_operacionais').first()).status,'RECEBIDA');
});
test('concurrent duplicate sends return the identical persisted receipt',async()=>{
    const dto=await order(),receipts=await Promise.all(Array.from({length:4},()=>adapter.send(dto)));
    for(const receipt of receipts)assert.deepEqual(receipt,receipts[0]);
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
});
for(const behavior of ['before_receipt','unavailable'])test('failure '+behavior+' cannot become a receipt or trigger an automatic resend',async()=>{
    const dto=await order();mode=behavior;await assert.rejects(consumer().deliver(dto));
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
    mode='success';await assert.rejects(consumer().deliver(dto),e=>e.code==='RECOVERY_REQUIRED');
    assert.equal((await db('infinitepay_entregas_operacionais').first()).status,'INCERTA');
});
for(const behavior of ['timeout_after_receipt','missing_receipt','invalid_receipt'])test('restart recovers '+behavior+' by checking the original receipt',async()=>{
    const dto=await order();mode=behavior;await assert.rejects(consumer().deliver(dto));
    assert.equal((await db('infinitepay_entregas_operacionais').first()).status,'INCERTA');
    adapter=await create({db,secret});const recovered=await consumer().recover(dto.key);assert.equal(recovered.acknowledged,true);
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
});
test('false, changed, cross-destination and cross-order receipts are rejected',async()=>{
    const dto=await order(),receipt=await adapter.send(dto),other=await order();
    for(const changed of [{receiptId:'00000000-0000-4000-8000-000000000001'},{signature:'0'.repeat(64)},
        {destination:'other'},{pedidoId:other.pedidoId},{printed:true},{stage:'PRINTED'},
        {pedidoId:[receipt.pedidoId]},{key:[receipt.key]},{acknowledged:'true'}])assert.equal(await adapter.verifyReceipt({...receipt,...changed},dto),false);
    const restarted=await create({db,secret:randomBytes(32)});assert.equal(await restarted.verifyReceipt(receipt,dto),false);
});
test('a changed persistent deployment identity cannot receive deliveries under the former identity',async()=>{
    const dto=await order();await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:'88962c70-a91e-4bf2-941d-a232f7201438'});
    await assert.rejects(adapter.send(dto));assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
});
test('payload and identity drift cannot reuse an idempotency key',async()=>{
    const dto=await order();await adapter.send(dto);
    await assert.rejects(adapter.send({...dto,pedidoId:dto.pedidoId+1}));
    await assert.rejects(adapter.send({...dto,apiKey:'SYNTHETIC_FORBIDDEN'}));
    await assert.rejects(adapter.send({...dto,tipo:'PRINT_NOW'}));
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
});
for(const status of ['AGUARDANDO','INCERTA','FALHOU'])test('consumer never sends unpaid order '+status+' to the synthetic destination',async()=>{
    const dto=await order(status);await assert.rejects(consumer().deliver(dto),e=>e.code==='ORDER_INELIGIBLE');
    assert.equal(await adapter.lookupReceipt(dto),null);
});
test('revoked authorization and aborted calls produce no receiver record',async()=>{
    const dto=await order(),c=createDurableOrderConsumer({db,adapter,authorizeSend:async()=>false});
    await assert.rejects(c.deliver(dto),e=>e.code==='DELIVERY_NOT_AUTHORIZED');
    await assert.rejects(adapter.send(dto,{signal:AbortSignal.abort()}));assert.equal(await adapter.lookupReceipt(dto),null);
});
test('receiver unavailable during recovery is not interpreted as confirmed absence',async()=>{
    const dto=await order();mode='timeout_after_receipt';await assert.rejects(consumer().deliver(dto));mode='unavailable';
    await assert.rejects(consumer().recover(dto.key));assert.equal((await db('infinitepay_entregas_operacionais').first()).status,'INCERTA');
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
});
test('a terminated sender recovers the persisted synthetic receipt after its lease expires',async()=>{
    const dto=await order(),config=db.client.config;
    const receiverUrl=new URL('../../src/homologation/syntheticOrderDestination.js',import.meta.url).href;
    const consumerUrl=new URL('../../src/services/durableOrderConsumer.js',import.meta.url).href;
    const source=`import knex from 'knex';
        const {createSyntheticOrderDestination}=await import(${JSON.stringify(receiverUrl)});
        const {createDurableOrderConsumer}=await import(${JSON.stringify(consumerUrl)});
        let input='';for await(const chunk of process.stdin)input+=chunk;const data=JSON.parse(input);
        const db=knex({client:'pg',connection:data.connection,searchPath:data.searchPath,pool:{min:0,max:2}});
        const receiver=await createSyntheticOrderDestination({db,secret:Buffer.from(data.secret,'base64')});
        const adapter={...receiver,async send(dto,options){await receiver.send(dto,options);process.send('synthetic-received');await new Promise(()=>{});}};
        await createDurableOrderConsumer({db,adapter,leaseMs:5000,timeoutMs:5000}).deliver(data.dto);`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:fileURLToPath(new URL('../../',import.meta.url)),windowsHide:true,
        stdio:['pipe','ignore','ignore','ipc']});
    const exited=new Promise(resolve=>child.once('exit',resolve));let timer;
    try {
        const received=new Promise((resolve,reject)=>{
            timer=setTimeout(()=>reject(new Error('Destino sintético não confirmou recebimento no prazo.')),10000);
            child.once('message',value=>value==='synthetic-received'?resolve():reject(new Error('Mensagem sintética inválida.')));
            child.once('error',reject);child.once('exit',()=>reject(new Error('Processo sintético encerrou antes do recebimento.')));
        });
        child.stdin.end(JSON.stringify({connection:config.connection,searchPath:config.searchPath,secret:secret.toString('base64'),dto}));
        await received;clearTimeout(timer);child.kill('SIGTERM');await exited;
        const restarted=await create({db,secret});
        const result=await createDurableOrderConsumer({db,adapter:restarted,now:()=>new Date(Date.now()+6000)}).recover(dto.key);
        assert.equal(result.acknowledged,true);assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
        assert.deepEqual((await db('infinitepay_entregas_tentativas').orderBy('numero')).map(r=>r.status),['INCERTA','RECEBIDA']);
    }finally{clearTimeout(timer);if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exited;}}
});
test('synthetic adapter rejects certified, persistent demo and remote connections before any SQL',async()=>{
    let calls=0;
    for(const connection of [{host:'127.0.0.1',database:'infinitepay_credit_homologacao'},
        {host:'remote.invalid.test',database:'infinitepay_phase1_test'},{host:'127.0.0.1',database:'marmitaria'}]){
        const fake=()=>{};fake.client={config:{connection,searchPath:['iptest_synthetic']}};fake.raw=async()=>{calls++;};
        await assert.rejects(create({db:fake,secret}));
    }
    const fake=()=>{};fake.client={config:{connection:{host:'127.0.0.1',database:'infinitepay_phase1_test'},searchPath:['infinitepay_demo']}};
    fake.raw=async()=>{calls++;};await assert.rejects(create({db:fake,secret}));assert.equal(calls,0);
});
test('independent synthetic recipients deduplicate against persistent storage and retain the same receipt',async()=>{
    const dto=await order(),second=await create({db,secret});
    const [one,two]=await Promise.all([adapter.send(dto),second.send(dto)]);
    assert.equal(one.receiptId,two.receiptId);assert.equal(await second.verifyReceipt(one,dto),true);
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
    const restarted=await create({db,secret});assert.equal((await restarted.lookupReceipt(dto)).receiptId,one.receiptId);
});
test('a different station or authentication key cannot claim an existing receipt',async()=>{
    const dto=await order(),receipt=await adapter.send(dto),wrongStation=await create({db,secret,id:'wrong-station'});
    assert.equal(await wrongStation.verifyReceipt(receipt,dto),false);await assert.rejects(wrongStation.send(dto));
    const wrongKey=await create({db,secret:randomBytes(32)});assert.equal(await wrongKey.verifyReceipt(receipt,dto),false);
    assert.equal(Number((await db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
});
});
