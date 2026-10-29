import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {createTestDatabase} from '../helpers/testDatabase.js';
import {createDurableOrderConsumer} from '../../src/services/durableOrderConsumer.js';

let fixture,db,method,create;
before(async()=>{
    ({createOperationalSocketDestination:create}=await import('../../src/services/operationalSocketDestination.js'));
    fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();
    [method]=await db('metodos_pagamento').insert({nome:'Synthetic PIX socket',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
});
after(async()=>{await fixture?.close();});
async function release(status='PAGA') {
    const date=new Date();
    const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',
        metodo_entrega:'Retirada',metodo_pagamento_id:method.id,valor_total:'1.00',fluxo_pagamento:'INFINITEPAY',liberado_cozinha_em:date}).returning('*');
    await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:randomUUID(),status,valor_centavos:100,
        valor_base_provider_centavos:100,provider_verified_at:date,pago_em:date,transaction_nsu:'SYNTHETIC-'+order.id,
        invoice_slug:'SYNTHETIC-'+order.id,capture_method:'pix',valid_until:date});
    const [event]=await db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:'pedido_liberado:'+order.id}).returning('*');
    return {id:event.id,pedidoId:order.id,tipo:event.tipo,key:event.chave_unica};
}
const loadOrder=async id=>({...await db('pedidos').where({id}).first(),cozinha_autorizada:true});
function destination(io,extra={}) {return create({db,io,loadOrder,deploymentId:'synthetic-deployment',...extra});}

test('existing Socket.IO room receives a confirmed order once; receipt means persistent availability, never physical print',async()=>{
    const server=createServer(),io=new Server(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        // Engine.IO polling exercises the real Socket.IO protocol without another client dependency.
        const url='http://127.0.0.1:'+server.address().port+'/socket.io/?EIO=4&transport=polling';
        io.on('connection',socket=>socket.join('pedidos'));
        const hello=await (await fetch(url)).text(),sid=JSON.parse(hello.slice(1)).sid;
        await fetch(url+'&sid='+sid,{method:'POST',body:'40'});
        assert.match(await (await fetch(url+'&sid='+sid)).text(),/^40/);
        const dto=await release(),adapter=destination(io),consumer=createDurableOrderConsumer({db,adapter});
        const packet=fetch(url+'&sid='+sid).then(response=>response.text());
        const receipt=await consumer.deliver(dto);
        const received=await packet;assert.match(received,/novo_pedido_recebido/);
        const [,order]=JSON.parse(received.slice(2));assert.equal(order.id,dto.pedidoId);assert.equal(order.cozinha_autorizada,true);
        assert.equal(receipt.receiptId.startsWith('available:'),true);
        assert.deepEqual(await consumer.deliver(dto),receipt);
        assert.equal((await db('infinitepay_entregas_operacionais').where({chave_unica:dto.key}).first()).tentativas,1);
        assert.equal((await db('pagamentos').where({pedido_id:dto.pedidoId}).first()).status,'PAGA');
    }finally{await new Promise(resolve=>io.close(resolve));if(server.listening)await new Promise(resolve=>server.close(resolve));}
});

test('socket unavailable and application restart preserve the operational order and deduplicate the logical delivery',async()=>{
    const dto=await release();let sends=0;
    const io={to(room){assert.equal(room,'pedidos');return {emit(){sends++;throw new Error('SYNTHETIC_SOCKET_OFFLINE');}};}};
    const first=await createDurableOrderConsumer({db,adapter:destination(io)}).deliver(dto);
    const next=await createDurableOrderConsumer({db,adapter:destination(io)}).deliver(dto);
    assert.deepEqual(next,first);assert.equal(sends,1);
    assert.equal((await loadOrder(dto.pedidoId)).id,dto.pedidoId);
    assert.equal((await destination(io).lookupReceipt(dto)).receiptId,first.receiptId);
});

test('unpaid, false read model, conflicting outbox and forged receipts cannot send or acknowledge an order',async()=>{
    let sends=0;const io={to(){return {emit(){sends++;}};}};
    const pending=await release('AGUARDANDO'),adapter=destination(io);
    await assert.rejects(adapter.send(pending));
    const dto=await release();await assert.rejects(adapter.send({...dto,key:'other'}));
    await assert.rejects(destination(io,{loadOrder:async()=>({id:dto.pedidoId,cozinha_autorizada:false})}).send(dto));
    const receipt=await adapter.lookupReceipt(dto);
    assert.equal(await adapter.verifyReceipt({...receipt,receiptId:'forged'},dto),false);
    assert.equal(await adapter.verifyReceipt({...receipt,pedidoId:pending.pedidoId},dto),false);
    assert.equal(sends,0);
});

test('a print failure is outside logical delivery: paid data remains recoverable, without an automatic reprint',async()=>{
    const dto=await release();let notifications=0,prints=0;
    const adapter=destination({to(){return {emit(){notifications++;}};}});
    const consumer=createDurableOrderConsumer({db,adapter});await consumer.deliver(dto);
    const simulatedOperatorPrint=()=>{prints++;throw new Error('SYNTHETIC_QZ_UNAVAILABLE');};
    assert.throws(simulatedOperatorPrint);
    await createDurableOrderConsumer({db,adapter}).deliver(dto);
    assert.equal(notifications,1);assert.equal(prints,1);
    assert.equal((await loadOrder(dto.pedidoId)).id,dto.pedidoId);
    assert.equal((await db('infinitepay_entregas_operacionais').where({chave_unica:dto.key}).first()).status,'RECEBIDA');
});
