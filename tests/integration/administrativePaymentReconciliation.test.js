import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { infinitepaySessionCsrf } from '../../src/utils/infinitepaySessionCsrf.js';

describe('authenticated administrative reconciliation schedules existing evidence only', { concurrency:false }, () => {
    let fixture, db, child, base, method;
    const origin='https://shop.invalid.test', secret=randomBytes(32).toString('hex');
    const tokens=new Map();
    const token=id=>{
        if(!tokens.has(id))tokens.set(id,jwt.sign({id,cargo:'admin'},secret,{expiresIn:'5m'}));
        return tokens.get(id);
    };
    before(async()=>{
        fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();
        await db('niveis_acesso').insert([{id:1,nome:'admin',descricao:'Synthetic'}, {id:2,nome:'inactive',descricao:'Synthetic',ativo:false}]);
        await db('usuarios').insert([1,2,3,4].map(id=>({id,nome:'Synthetic',email:`synthetic-${id}@invalid.test`,senha_hash:'NO_LOGIN',
            nivel_acesso_id:id===4?2:1,ativo:id!==3})));
        const permissions=await db('permissoes').whereIn('nome',['pagamentos.visualizar','pagamentos.conciliar']);
        await db('permissoes_usuarios').insert(permissions.map(p=>({usuario_id:1,permissao_id:p.id})));
        [method]=await db('metodos_pagamento').insert({nome:'Synthetic Pix',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        const source=`
            import express from 'express';
            import cookieParser from 'cookie-parser';
            const {default:router}=await import('./src/routes/FinanceiroPedidos.Routes.js');
            const {default:db}=await import('./src/database/connection.js');
            const app=express();app.set('trust proxy','loopback');app.use(express.json());app.use(cookieParser());
            app.use('/pagamentos/admin',router);
            app.use((error,req,res,next)=>res.status(error.statusCode||500).json({status:'fail'}));
            const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
            process.on('message',async value=>{if(value==='close'){await new Promise(resolve=>server.close(resolve));await db.destroy();process.exit(0);}});
        `;
        child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../..',import.meta.url),windowsHide:true,
            env:{...process.env,NODE_ENV:'test',TEST_DATABASE_SCHEMA:fixture.schema,JWT_SECRET:secret,ALLOWED_ORIGINS:origin+',http://shop.invalid.test',
                DOTENV_CONFIG_PATH:join(tmpdir(),'missing-synthetic-'+randomUUID())},stdio:['ignore','pipe','pipe','ipc']});
        let diagnostics='';child.stdout.on('data',data=>{diagnostics+=data;});child.stderr.on('data',data=>{diagnostics+=data;});
        const ready=await Promise.race([once(child,'message').then(([message])=>message),once(child,'exit').then(()=>{throw new Error('Synthetic HTTP server exited: '+diagnostics);})]);
        base='http://127.0.0.1:'+ready.port+'/pagamentos/admin';
    });
    after(async()=>{
        if(child?.exitCode===null){const stopped=once(child,'exit');child.send('close');await stopped;}
        await fixture?.close();
    });
    async function order(status='INCERTA', extra={}) {
        const [pedido]=await db('pedidos').insert({nome_cliente:'Synthetic private name',telefone_cliente:'00000000000',endereco_cliente:'Synthetic',
            tipo_pedido:'Remoto',metodo_entrega:'Retirada',metodo_pagamento_id:method.id,valor_total:20,fluxo_pagamento:'INFINITEPAY'}).returning('*');
        const [payment]=await db('pagamentos').insert({pedido_id:pedido.id,tentativa_numero:1,order_nsu:'PRIVATE-ORDER-'+pedido.id,
            status,valor_centavos:2000,valid_until:'2050-01-01T00:00:00Z',...extra}).returning('*');
        return {pedido,payment};
    }
    async function event(f,extra={}) {
        const [row]=await db('pagamentos_eventos').insert({pagamento_id:f.payment.id,event_key:'synthetic:'+randomUUID(),tipo_evento:'paid',
            payload_filtrado:{version:1,type:'paid',orderNsu:f.payment.order_nsu,transactionNsu:'PRIVATE-TXN-'+f.pedido.id,
                invoiceSlug:'PRIVATE-SLUG-'+f.pedido.id,extra:'KEEP-ORIGINAL-PAYLOAD'},status_processamento:'ERRO',tentativas:5,
            ultimo_erro:'PAYMENT_CHECK_UNAVAILABLE',...extra}).returning('*');
        return row;
    }
    async function request(path,{id=1,method='GET',body,headers={},authenticate=true}={}) {
        return fetch(base+path,{method,headers:{...(authenticate?{Cookie:'token='+token(id)}:{}),'X-Forwarded-Proto':'https',
            ...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    }
    const reconcile=(f,requestId=randomUUID(),options={})=>request('/'+f.pedido.id+'/conciliar',{method:'POST',body:{request_id:requestId},
        headers:{Origin:origin,'X-Infinitepay-CSRF':infinitepaySessionCsrf(token(options.id??1),secret)},...options});

    test('HTTPS CSRF bootstrap and explicit reconciliation permission reject stale admin claims',async()=>{
        assert.equal((await request('/csrf',{authenticate:false})).status,401);
        assert.equal((await request('/csrf',{id:3})).status,401);
        assert.equal((await request('/csrf',{id:4})).status,401);
        const response=await request('/csrf');assert.equal(response.status,200);
        const data=await response.json();assert.equal(data.csrf_token,infinitepaySessionCsrf(token(1),secret));
        assert.equal(response.headers.get('cache-control'),'no-store');
        const f=await order();assert.equal((await reconcile(f,randomUUID(),{id:2})).status,403);
    });
    test('exhausted event is requeued with durable prior counters while payment and payload remain unchanged',async()=>{
        const f=await order(),original=await event(f),requestId=randomUUID();
        const response=await reconcile(f,requestId);assert.equal(response.status,200);
        assert.deepEqual(await response.json(),{status:'success',data:{pedido_id:f.pedido.id,solicitacao_id:requestId,status:'SOLICITADA',eventos_reagendados:1}});
        const saved=await db('pagamentos_eventos').where({id:original.id}).first();
        assert.equal(saved.tentativas,0);assert.equal(saved.status_processamento,'PENDENTE');assert.equal(saved.ultimo_erro,null);
        assert.deepEqual(saved.payload_filtrado,original.payload_filtrado);assert.equal(saved.event_key,original.event_key);
        assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);
        assert.deepEqual(await db('pedidos').where({id:f.pedido.id}).first(),f.pedido);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n),0);
        const audit=await db('pagamentos_eventos').where({event_key:'admin_conciliacao:'+requestId}).first();
        assert.equal(audit.tipo_evento,'ADMIN_CONCILIACAO');assert.equal(audit.status_processamento,'CONCLUIDO');
        assert.equal(audit.payload_filtrado.usuario_id,1);assert.equal(audit.payload_filtrado.eventos[0].tentativas_anteriores,5);
        assert.equal(audit.payload_filtrado.eventos[0].erro_anterior,'PAYMENT_CHECK_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(audit.payload_filtrado),/PRIVATE-|KEEP-ORIGINAL|Synthetic private/);
    });
    test('same request is concurrent and durable idempotent while ownership conflicts cannot reuse its UUID',async()=>{
        const f=await order(),original=await event(f),requestId=randomUUID();
        const responses=await Promise.all([reconcile(f,requestId),reconcile(f,requestId)]);
        const values=await Promise.all(responses.map(async response=>{assert.equal(response.status,200);return response.json();}));
        assert.deepEqual(values[0],values[1]);
        assert.equal(Number((await db('pagamentos_eventos').where({event_key:'admin_conciliacao:'+requestId}).count('* as n').first()).n),1);
        const again=await reconcile(f);assert.equal((await again.json()).data.eventos_reagendados,0);
        assert.equal((await db('pagamentos_eventos').where({id:original.id}).first()).tentativas,0);
        const other=await order();assert.equal((await reconcile(other,requestId)).status,409);
        const permission=await db('permissoes').where({nome:'pagamentos.conciliar'}).first();
        await db('permissoes_usuarios').insert({usuario_id:2,permissao_id:permission.id});
        assert.equal((await reconcile(f,requestId,{id:2})).status,409);
    });
    test('unknown identifiers preserve pending identification without inventing provider events',async()=>{
        const f=await order(),original=await event(f,{payload_filtrado:{version:1,type:'paid',orderNsu:f.payment.order_nsu},
            status_processamento:'PENDENTE_IDENTIFICACAO',tentativas:2});
        const result=await reconcile(f);assert.equal(result.status,200);
        assert.equal((await result.json()).data.status,'SEM_IDENTIFICADORES');
        assert.deepEqual(await db('pagamentos_eventos').where({id:original.id}).first(),original);
        assert.equal(Number((await db('pagamentos_eventos').where({pagamento_id:f.payment.id}).whereNot({tipo_evento:'ADMIN_CONCILIACAO'}).count('* as n').first()).n),1);
        assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);
    });
    test('processing or leased events cannot be reset and ready events retain their existing retry budget',async()=>{
        const f=await order();
        const processing=await event(f,{status_processamento:'PROCESSANDO',locked_by:randomUUID(),locked_until:new Date(Date.now()+60000)});
        const leased=await event(f,{locked_by:randomUUID(),locked_until:new Date(Date.now()+60000)});
        const pending=await event(f,{status_processamento:'PENDENTE',tentativas:2,proxima_tentativa_em:new Date(Date.now()+60000)});
        const result=await reconcile(f);assert.equal(result.status,200);assert.equal((await result.json()).data.eventos_reagendados,1);
        assert.deepEqual(await db('pagamentos_eventos').where({id:processing.id}).first(),processing);
        assert.deepEqual(await db('pagamentos_eventos').where({id:leased.id}).first(),leased);
        assert.equal((await db('pagamentos_eventos').where({id:pending.id}).first()).tentativas,2);
    });
    test('failed audit rolls back every reschedule and preserves retry evidence',async()=>{
        const f=await order(),original=await event(f);
        await db.raw("ALTER TABLE pagamentos_eventos ADD CONSTRAINT synthetic_reject_admin_audit CHECK (tipo_evento <> 'ADMIN_CONCILIACAO') NOT VALID");
        try{assert.equal((await reconcile(f)).status,500);}finally{await db.raw('ALTER TABLE pagamentos_eventos DROP CONSTRAINT synthetic_reject_admin_audit');}
        assert.deepEqual(await db('pagamentos_eventos').where({id:original.id}).first(),original);
        assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);
    });
    test('CSRF, HTTPS, origin, JSON and a closed request schema are mandatory before mutation',async()=>{
        const f=await order();
        const baseHeaders={Origin:origin,'X-Infinitepay-CSRF':infinitepaySessionCsrf(token(1),secret)};
        for(const headers of [{Origin:origin},{...baseHeaders,'X-Infinitepay-CSRF':'bad'},{...baseHeaders,Origin:'https://attacker.invalid.test'},
            {...baseHeaders,Origin:'http://shop.invalid.test'},
            {...baseHeaders,'X-Forwarded-Proto':'http'}]){
            assert.equal((await request('/'+f.pedido.id+'/conciliar',{method:'POST',body:{request_id:randomUUID()},headers})).status,403);
        }
        assert.equal((await request('/'+f.pedido.id+'/conciliar',{method:'POST',body:{request_id:randomUUID()},headers:{...baseHeaders,'Content-Type':'text/plain'}})).status,415);
        for(const body of [{request_id:'not-a-uuid'},{request_id:randomUUID(),paid:true}]){
            assert.equal((await request('/'+f.pedido.id+'/conciliar',{method:'POST',body,headers:baseHeaders})).status,400);
        }
    });
    test('verified payment returns a no-op and unverified status cannot be promoted by an administrator',async()=>{
        const f=await order('PAGA',{provider_verified_at:new Date(),pago_em:new Date(),transaction_nsu:'PRIVATE-VERIFIED-TXN',
            invoice_slug:'PRIVATE-VERIFIED-SLUG',capture_method:'pix',valor_base_provider_centavos:2000,valor_pago_provider_centavos:2000,installments:1});
        const response=await reconcile(f);assert.equal(response.status,200);assert.equal((await response.json()).data.status,'JA_CONFIRMADO');
        assert.deepEqual(await db('pagamentos').where({id:f.payment.id}).first(),f.payment);
        const unverified=await order('PAGA');assert.equal((await reconcile(unverified)).status,409);
        const awaiting=await order('AGUARDANDO');assert.equal((await reconcile(awaiting)).status,409);
    });
});
