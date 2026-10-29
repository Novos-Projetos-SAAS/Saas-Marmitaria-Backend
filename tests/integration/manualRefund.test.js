import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createTestDatabase} from '../helpers/testDatabase.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import {createInfinitepayEventsService} from '../../src/services/infinitepayEventsService.js';
import {parseObservedInfinitepayEvent} from '../../src/services/infinitepayObservedContracts.js';

describe('manual refund tracks intent, external report and independent evidence separately',{concurrency:false},()=>{
    let f,db,make,credential,method,size,permission,previous;
    before(async()=>{
        ({createManualRefundService:make}=await import('../../src/services/manualRefundService.js'));
        f=await createTestDatabase();db=f.db;await db.migrate.latest();
        previous=Object.fromEntries(['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(k=>[k,process.env[k]]));
        process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');delete process.env.INFINITEPAY_ENCRYPTION_KEYS;delete process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION;
        const [role]=await db('niveis_acesso').insert({nome:'admin',descricao:'SYNTHETIC'}).returning('*');
        await db('usuarios').insert([1,2].map(id=>({id,nome:'SYNTHETIC',email:`refund-${id}@invalid.test`,senha_hash:'NONE',nivel_acesso_id:role.id})));
        // Explicit fixture setup, never a migration or an automatic operational grant.
        [permission]=await db('permissoes').insert({nome:'pagamentos.estornar',descricao:'Synthetic explicit permission'}).returning('*');
        await db('permissoes_usuarios').insert({usuario_id:1,permissao_id:permission.id});
        [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-refund',...encryptApiKey('SYNTHETIC_REFUND_KEY','synthetic-refund')}).returning('*');
        [method]=await db('metodos_pagamento').insert({nome:'Synthetic Pix',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        [size]=await db('tamanhos_marmitas').insert({nome:'Synthetic',preco_base:1}).returning('*');
    });
    after(async()=>{await f?.close();for(const[k,v]of Object.entries(previous||{})){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
    async function fixture() {
        const instant=new Date();
        const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
            metodo_pagamento_id:method.id,valor_total:1,fluxo_pagamento:'INFINITEPAY',liberado_cozinha_em:instant,status:'Em Preparo'}).returning('*');
        await db('itens_pedido').insert({pedido_id:order.id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:1,subtotal:1});
        const [payment]=await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:randomUUID(),status:'PAGA',valor_centavos:100,
            valor_base_provider_centavos:100,valor_pago_provider_centavos:110,pago_em:instant,provider_verified_at:instant,valid_until:instant,
            transaction_nsu:'SYNTHETIC-TX-'+order.id,invoice_slug:'SYNTHETIC-SLUG-'+order.id,capture_method:'pix',credencial_id:credential.id,handle_snapshot:credential.handle}).returning('*');
        await db('outbox_eventos').insert({pedido_id:order.id,tipo:'PEDIDO_LIBERADO',chave_unica:'pedido_liberado:'+order.id});
        return {order,payment,service:make({db})};
    }
    const request=(x,input={request_id:randomUUID(),motivo:'SOLICITACAO_CLIENTE'},actorId=1)=>x.service.request({pedidoId:x.order.id,actorId,input});
    const execute=(x,r,input={request_id:randomUUID(),executado_em:new Date().toISOString(),referencia_sha256:'a'.repeat(64)})=>x.service.execute({pedidoId:x.order.id,estornoId:r.estorno_id,actorId:1,input});
    const reconcile=(x,r)=>x.service.reconcile({pedidoId:x.order.id,estornoId:r.estorno_id,actorId:1,input:{request_id:randomUUID()}});

    test('solicitation, reported execution and pending reconciliation do not change finance, revenue, kitchen, items or outbox',async()=>{
        const x=await fixture(),before=await db('pagamentos').where({id:x.payment.id}).first();
        const r=await request(x);assert.equal(r.estado,'SOLICITADO');
        assert.equal((await execute(x,r)).estado,'EXECUCAO_EXTERNA_INFORMADA');
        assert.equal((await reconcile(x,r)).estado,'AGUARDANDO_PROVA_INDEPENDENTE');
        assert.deepEqual(await db('pagamentos').where({id:x.payment.id}).first(),before);
        assert.equal(Number((await db('vw_rel_pedidos_financeiros').where({id:x.order.id}).first()).valor_venda),1);
        assert.equal((await db('pedidos').where({id:x.order.id}).first()).status,'Em Preparo');
        assert.equal(Number((await db('itens_pedido').where({pedido_id:x.order.id}).count('* as n').first()).n),1);
        assert.equal(Number((await db('outbox_eventos').where({pedido_id:x.order.id}).count('* as n').first()).n),1);
        const tracked=await x.service.inspect({pedidoId:x.order.id,actorId:1});assert.equal(tracked.estado,'AGUARDANDO_PROVA_INDEPENDENTE');assert.equal(tracked.historico.length,3);
        assert.doesNotMatch(JSON.stringify(tracked),/SYNTHETIC-TX|SYNTHETIC-SLUG|SYNTHETIC_REFUND_KEY|ciphertext/);
    });
    test('explicit permission, active user/role, exact bodies and existing proof are mandatory without admin bypass',async()=>{
        const x=await fixture();await assert.rejects(request(x,undefined,2),e=>e.statusCode===403);
        for(const input of [{request_id:randomUUID(),motivo:'OUTRO',status:'ESTORNADA'}, {request_id:'bad',motivo:'OUTRO'}, {request_id:randomUUID(),motivo:'secret'}])await assert.rejects(request(x,input),e=>e.statusCode===400);
        await db('usuarios').where({id:1}).update({ativo:false});try{await assert.rejects(request(x),e=>e.statusCode===403);}finally{await db('usuarios').where({id:1}).update({ativo:true});}
        await db('pagamentos').where({id:x.payment.id}).update({provider_verified_at:null});await assert.rejects(request(x),e=>e.statusCode===409);
    });
    test('UUID replay is bound to actor/action/content and concurrent requests cannot create another refund intention',async()=>{
        const x=await fixture(),input={request_id:randomUUID(),motivo:'OUTRO'};
        const values=await Promise.all([request(x,input),request(x,input)]);assert.deepEqual(values[0],values[1]);
        await assert.rejects(request(x,{...input,motivo:'ERRO_OPERACIONAL'}),e=>e.statusCode===409);
        await assert.rejects(request(x),e=>e.statusCode===409);
        const execution={request_id:randomUUID(),executado_em:new Date().toISOString(),referencia_sha256:'b'.repeat(64)};
        assert.deepEqual(await execute(x,values[0],execution),await execute(x,values[0],execution));
        await assert.rejects(execute(x,values[0]),e=>e.statusCode===409);
    });
    test('audit storage failure rolls back the intention and cannot modify a paid order',async()=>{
        const x=await fixture(),fail=q=>{if(q.sql.startsWith('insert into "pagamentos_eventos"'))throw new Error('SYNTHETIC_SECRET_FAILURE');};
        db.on('query',fail);try{await assert.rejects(request(x));}finally{db.removeListener('query',fail);}
        assert.equal((await x.service.inspect({pedidoId:x.order.id,actorId:1})).estado,'SEM_SOLICITACAO');
        assert.equal((await db('pagamentos').where({id:x.payment.id}).first()).status,'PAGA');
    });
    test('another order, changed financial identifiers and a different actor cannot reuse a refund command',async()=>{
        const x=await fixture(),y=await fixture(),input={request_id:randomUUID(),motivo:'OUTRO'},r=await request(x,input);
        await assert.rejects(y.service.execute({pedidoId:y.order.id,estornoId:r.estorno_id,actorId:1,input:{request_id:randomUUID(),executado_em:new Date().toISOString(),referencia_sha256:'c'.repeat(64)}}),e=>e.statusCode===404);
        await db('permissoes_usuarios').insert({usuario_id:2,permissao_id:permission.id});
        try{await assert.rejects(request(x,input,2),e=>e.statusCode===409);}finally{await db('permissoes_usuarios').where({usuario_id:2,permissao_id:permission.id}).del();}
        await db('pagamentos').where({id:x.payment.id}).update({transaction_nsu:'CHANGED-SYNTHETIC-TX'});
        await assert.rejects(execute(x,r),e=>e.statusCode===409);
    });
    test('refunded signal with correlated IDs cannot confirm financial reversal from paid=true alone',async()=>{
        const x=await fixture(),r=await request(x);await execute(x,r);
        const events=createInfinitepayEventsService({db,parseEvent:parseObservedInfinitepayEvent,client:{async checkPayment(){return {paid:true,amount:100,paidAmount:110,installments:1,captureMethod:'pix'};}}});
        const e=await events.receive({event_type:'refunded',order_nsu:x.payment.order_nsu,transaction_nsu:x.payment.transaction_nsu,invoice_slug:x.payment.invoice_slug});
        await events.processEvent(e.eventId);
        assert.equal((await db('pagamentos').where({id:x.payment.id}).first()).status,'PAGA');
        assert.equal((await db('pagamentos_eventos').where({id:e.eventId}).first()).ultimo_erro,'LIFECYCLE_UNVERIFIED');
        assert.equal((await reconcile(x,r)).estado,'AGUARDANDO_PROVA_INDEPENDENTE');
    });
    test('only preexisting independent correlated refund proof closes the manual record; production and history persist',async()=>{
        const x=await fixture(),r=await request(x);await execute(x,r);
        const events=createInfinitepayEventsService({db,parseEvent:parseObservedInfinitepayEvent,client:{async checkPayment(){return {paid:true,amount:100,paidAmount:110,installments:1,captureMethod:'pix',financialState:'ESTORNADA'};}}});
        const e=await events.receive({event_type:'refunded',order_nsu:x.payment.order_nsu,transaction_nsu:x.payment.transaction_nsu,invoice_slug:x.payment.invoice_slug});await events.processEvent(e.eventId);
        const before=await db('pagamentos').where({id:x.payment.id}).first();assert.equal(before.status,'ESTORNADA');
        assert.equal((await reconcile(x,r)).estado,'CONFIRMADO_POR_EVIDENCIA');
        assert.deepEqual(await db('pagamentos').where({id:x.payment.id}).first(),before);
        assert.equal(Number((await db('vw_rel_pedidos_financeiros').where({id:x.order.id}).first()).valor_venda),0);
        assert.deepEqual(await db('pedidos').where({id:x.order.id}).first(),x.order);
        assert.equal(Number((await db('outbox_eventos').where({pedido_id:x.order.id}).count('* as n').first()).n),1);
    });
});
