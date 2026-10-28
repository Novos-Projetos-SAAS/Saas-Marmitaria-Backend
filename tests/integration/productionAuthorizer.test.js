import {test,beforeEach,afterEach,describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {createHmac} from 'node:crypto';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import express from 'express';
import {initializeInfinitepayApplication,validateInfinitepayEnvironment} from '../../src/infinitepayApplication.js';
import {configureProductionProxy} from '../../src/config/infinitepayProduction.js';

describe('production capability authorization with synthetic identities',{concurrency:false},()=>{
let f,db,env,clock,secret,session,actor,credential,make,oldKey;
beforeEach(async()=>{
    f=await createTestDatabase();db=f.db;await db.migrate.latest();env=syntheticProductionEnvironment(testConnection());
    await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
    clock=new Date('2026-10-28T12:00:00Z');secret=randomBytes(32).toString('base64');
    oldKey=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
    const [role]=await db('niveis_acesso').insert({nome:'synthetic-admin',descricao:'SYNTHETIC'}).returning('*');
    [actor]=await db('usuarios').insert({nome:'SYNTHETIC',email:'production-authorizer@invalid.test',senha_hash:'SYNTHETIC',nivel_acesso_id:role.id}).returning('*');
    const [permission]=await db('permissoes').where({nome:'pagamentos.ativar_producao'});
    if(permission)await db('permissoes_usuarios').insert({usuario_id:actor.id,permissao_id:permission.id});
    [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-authorizer',...encryptApiKey('SYNTHETIC_AUTHORIZER_KEY','synthetic-authorizer')}).returning('*');
    await db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
    const seconds=clock.getTime()/1000,token=jwt.sign({id:actor.id,iat:seconds,exp:seconds+3600},secret,{algorithm:'HS256'});
    session={token,origin:'https://shop.invalid.test',csrf:createHmac('sha256',secret).update('infinitepay-csrf-v1\0'+token).digest('base64url')};
    ({createProductionAuthorizer:make}=await import('../../src/services/productionAuthorizer.js'));
});
afterEach(async()=>{if(oldKey===undefined)delete process.env.INFINITEPAY_ENCRYPTION_KEY;else process.env.INFINITEPAY_ENCRYPTION_KEY=oldKey;await f?.close();});
const authorizer=()=>make({db,env,now:()=>clock,sessionSecret:()=>secret});
const context=operation=>({operation,database:env.INFINITEPAY_DATABASE_NAME,databaseId:env.INFINITEPAY_DATABASE_ID,
    deploymentId:env.INFINITEPAY_DATABASE_ID,environment:'production',publicOrigin:env.INFINITEPAY_PUBLIC_ORIGIN});
const approve=(a,capabilities=['WORKER','VERIFY_PAYMENT'])=>a.approve({session,capabilities,validForSeconds:300});

test('no approval means deny and the authorization decision is durable',async()=>{
    const a=authorizer();assert.equal(await a.authorize(context('WORKER')),false);
    const decisions=await db('infinitepay_autorizacao_decisoes');assert.equal(decisions.length,1);assert.equal(decisions[0].decisao,'DENY');
});
test('explicit administration authorizes only its declared capabilities',async()=>{
    const a=authorizer();const approval=await approve(a);assert.ok(approval.id);
    assert.equal(await a.authorize(context('WORKER')),true);assert.equal(await a.authorize(context('VERIFY_PAYMENT')),true);
    assert.equal(await a.authorize(context('CREATE_LINK')),false);assert.equal(await a.authorize(context('DELIVER_ORDER')),false);
    assert.equal((await db('config_infinitepay').first()).ativo,false);
});
test('a new process instance never inherits an approval from the previous instance',async()=>{
    const first=authorizer();await approve(first);assert.equal(await first.authorize(context('WORKER')),true);
    assert.equal(await authorizer().authorize(context('WORKER')),false);
});
test('administrative activation requires real session, exact origin, csrf and explicit permission',async()=>{
    const a=authorizer();
    for(const changed of [{token:'holder-token'},{origin:'https://evil.invalid.test'},{csrf:'wrong'},
        {token:jwt.sign({id:actor.id,exp:clock.getTime()/1000-1},secret)}]) {
        await assert.rejects(a.approve({session:{...session,...changed},capabilities:['WORKER'],validForSeconds:300}));
    }
    await db('permissoes_usuarios').where({usuario_id:actor.id}).del();
    await assert.rejects(approve(a));assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
});
test('revocation and emergency shutdown block later decisions without deleting approvals',async()=>{
    const a=authorizer(),approval=await approve(a);await a.revoke({session,id:approval.id});
    assert.equal(await a.authorize(context('WORKER')),false);await approve(a);
    await a.emergencyStop({session});assert.equal(await a.authorize(context('WORKER')),false);await assert.rejects(approve(a));
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),2);
});
test('expired approvals and revoked user permissions are never implicitly renewed',async()=>{
    const a=authorizer();await approve(a);clock=new Date(clock.getTime()+301000);assert.equal(await a.authorize(context('WORKER')),false);
    await approve(a);await db('usuarios').where({id:actor.id}).update({ativo:false});
    assert.equal(await a.authorize(context('WORKER')),false);
});
test('identity, environment, origin and credential tampering fail closed',async()=>{
    const a=authorizer();await approve(a);
    for(const extra of [{database:'other'},{databaseId:'00000000-0000-4000-8000-000000000001'},
        {deploymentId:'00000000-0000-4000-8000-000000000001'},{environment:'homologation'},
        {publicOrigin:'http://backend.invalid.test'},{credentialId:99999}]) assert.equal(await a.authorize({...context('VERIFY_PAYMENT'),...extra}),false);
    await assert.rejects(db('infinitepay_credenciais').where({id:credential.id}).update({api_key_tag:Buffer.alloc(16).toString('base64')}),/imutável/);
    process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
    assert.equal(await a.authorize(context('VERIFY_PAYMENT')),false);
});
test('approval integrity and audit storage are mandatory for authorization',async()=>{
    const a=authorizer(),approval=await approve(a);
    await db('infinitepay_autorizacoes_producao').where({id:approval.id}).update({capacidades:['WORKER','VERIFY_PAYMENT','CREATE_LINK']});
    assert.equal(await a.authorize(context('CREATE_LINK')),false);
    await approve(a);assert.equal(await a.authorize(context('WORKER')),true);
    await db.raw("CREATE FUNCTION synthetic_reject_auth_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET'; END $$");
    await db.raw('CREATE TRIGGER synthetic_reject_auth_audit BEFORE INSERT ON infinitepay_autorizacao_decisoes FOR EACH ROW EXECUTE FUNCTION synthetic_reject_auth_audit()');
    assert.equal(await a.authorize(context('WORKER')),false);
});
test('clock rollback never resurrects a previously expired approval',async()=>{
    const a=authorizer();await approve(a);clock=new Date('2026-10-28T12:05:01Z');assert.equal(await a.authorize(context('WORKER')),false);
    clock=new Date('2026-10-28T12:00:01Z');assert.equal(await a.authorize(context('WORKER')),false);
});
test('missing credential, invalid key and changed environment prevent administrative approval',async()=>{
    const a=authorizer();await db('config_infinitepay').where({id:1}).update({credencial_atual_id:null});await assert.rejects(approve(a));
    await db('config_infinitepay').where({id:1}).update({credencial_atual_id:credential.id});
    process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');await assert.rejects(approve(a));
    env.INFINITEPAY_PUBLIC_ORIGIN='https://other.invalid.test';await assert.rejects(approve(a));
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
});
test('permission revocation and session-signing-key rotation invalidate active approvals',async()=>{
    const a=authorizer();await approve(a);secret=randomBytes(32).toString('base64');assert.equal(await a.authorize(context('WORKER')),false);
    await db('permissoes_usuarios').where({usuario_id:actor.id}).del();assert.equal(await a.authorize(context('WORKER')),false);
});
test('concurrent approvals serialize and leave only one active credential grant',async()=>{
    const a=authorizer();await Promise.all([approve(a),approve(a)]);
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').whereNull('revogado_em').count('* as n').first()).n),1);
    assert.equal(await a.authorize(context('WORKER')),true);
});
test('requested validity cannot exceed fifteen minutes or the administrator session',async()=>{
    const a=authorizer();for(const ttl of [0,901,-1,1.2])await assert.rejects(a.approve({session,capabilities:['WORKER'],validForSeconds:ttl}));
    const token=jwt.sign({id:actor.id,iat:clock.getTime()/1000,exp:clock.getTime()/1000+10},secret);
    const short={...session,token,csrf:createHmac('sha256',secret).update('infinitepay-csrf-v1\0'+token).digest('base64url')};
    const approval=await a.approve({session:short,capabilities:['WORKER'],validForSeconds:300});assert.equal(approval.expiresAt,'2026-10-28T12:00:10.000Z');
});
test('failure writing approval audit rolls back the grant and never returns an approval',async()=>{
    const a=authorizer();await db.raw("CREATE FUNCTION synthetic_fail_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET'; END $$");
    await db.raw('CREATE TRIGGER synthetic_fail_approval_audit BEFORE INSERT ON infinitepay_autorizacao_decisoes FOR EACH ROW EXECUTE FUNCTION synthetic_fail_approval_audit()');
    await assert.rejects(approve(a));assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
});
test('audit never stores session tokens, csrf, key material or arbitrary request strings',async()=>{
    const a=authorizer();await approve(a);await a.authorize({...context('VERIFY_PAYMENT'),operation:'SYNTHETIC_SECRET_FROM_CLIENT'});
    const text=JSON.stringify(await db('infinitepay_autorizacao_decisoes'));
    for(const value of [session.token,session.csrf,secret,'SYNTHETIC_AUTHORIZER_KEY','SYNTHETIC_SECRET_FROM_CLIENT'])assert.equal(text.includes(value),false);
});
async function application(a,transport,operationalAdapter) {
    const app=express();configureProductionProxy(app,validateInfinitepayEnvironment(env));
    return initializeInfinitepayApplication({app,db,env,now:()=>clock,productionAuthorization:a.authorize,transport,operationalAdapter});
}
test('the prepared composition uses the implemented administrative authorizer without enabling checkout',async()=>{
    const a=authorizer();let service,requests=0;
    try {
        await approve(a);Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        service=await application(a,async()=>{requests++;throw new Error('SYNTHETIC_FORBIDDEN');});
        await service.start({intervalMs:60000});assert.equal(service.status().running,true);assert.equal(await service.runtime.checkoutEnabled(),false);
        await a.emergencyStop({session});assert.deepEqual(await service.runtime.processPending(),{events:0,deliveries:0,errors:0});assert.equal(requests,0);
    } finally{await service?.stop();}
});
test('financial verification is scoped to the original attempt credential, including explicit historical approval',async()=>{
    const a=authorizer();let service,dispatches=0;
    try {
        await approve(a);
        const [next]=await db('infinitepay_credenciais').insert({handle:credential.handle,...encryptApiKey('SYNTHETIC_NEXT_KEY',credential.handle)}).returning('*');
        await db('config_infinitepay').where({id:1}).update({credencial_atual_id:next.id});
        const [method]=await db('metodos_pagamento').insert({nome:'SYNTHETIC PIX',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        const pending=[];
        for(const c of [credential,next]) {
            const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
                fluxo_pagamento:'INFINITEPAY',metodo_pagamento_id:method.id,valor_total:10}).returning('*');
            const [payment]=await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-SCOPED-'+order.id,status:'INCERTA',
                valor_centavos:1000,valid_until:'2050-01-01T00:00:00Z',credencial_id:c.id,handle_snapshot:c.handle}).returning('*');pending.push(payment);
        }
        Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        service=await application(a,async(url,init)=>{assert.ok(url.endsWith('/payment_check'));dispatches++;
            const original=JSON.parse(init.body).order_nsu===pending[0].order_nsu;
            assert.equal(init.headers['X-Api-Key'],original?'SYNTHETIC_AUTHORIZER_KEY':'SYNTHETIC_NEXT_KEY');
            return {status:200,json:async()=>({paid:true,amount:1000,paid_amount:1000,installments:1,capture_method:'pix'})};});
        for(const p of pending)await service.runtime.receiveEvent({event_type:'paid',order_nsu:p.order_nsu,transaction_nsu:'SYNTHETIC-TXN-'+p.id,invoice_slug:'SYNTHETIC-SLUG-'+p.id});
        await service.start({intervalMs:60000});for(let n=0;n<200 && service.status().cycles===0;n++)await new Promise(r=>setTimeout(r,10));
        assert.equal((await db('pagamentos').where({id:pending[0].id}).first()).status,'PAGA');
        assert.equal((await db('pagamentos').where({id:pending[1].id}).first()).status,'INCERTA');assert.equal(dispatches,1);
        await approve(a);await db('pagamentos_eventos').where({status_processamento:'PENDENTE'}).update({proxima_tentativa_em:null});
        await service.runtime.processPending();assert.equal(dispatches,2);
        assert.equal((await db('pagamentos').where({id:pending[1].id}).first()).status,'PAGA');
    }finally{await service?.stop();}
});
test('delivery approval cannot be reused for a different recipient',async()=>{
    const a=authorizer();await a.approve({session,capabilities:['WORKER','DELIVER_ORDER'],destinationId:'synthetic-kitchen',validForSeconds:300});
    assert.equal(await a.authorize({...context('DELIVER_ORDER'),destinationId:'synthetic-kitchen'}),true);
    assert.equal(await a.authorize({...context('DELIVER_ORDER'),destinationId:'different-kitchen'}),false);
});
test('changing an adapter identity cannot reuse a newly approved recipient for the former consumer',async()=>{
    const a=authorizer();let service,sends=0;
    const adapter={id:'synthetic-kitchen',supportsIdempotency:true,async send(){sends++;throw new Error('SYNTHETIC_FORBIDDEN');},async lookupReceipt(){return null;},async verifyReceipt(){return true;}};
    try {
        Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'true'});
        service=await application(a,async()=>{throw new Error('SYNTHETIC_FINANCIAL_FORBIDDEN');},adapter);
        adapter.id='different-kitchen';await a.approve({session,capabilities:['WORKER','DELIVER_ORDER'],destinationId:adapter.id,validForSeconds:300});
        await assert.rejects(service.start({intervalMs:60000}));assert.equal(sends,0);
    }finally{await service?.stop();}
});
test('session expiry blocks future decisions even when a longer grant was requested',async()=>{
    const a=authorizer(),seconds=clock.getTime()/1000,token=jwt.sign({id:actor.id,iat:seconds,exp:seconds+2},secret);
    await a.approve({session:{...session,token,csrf:createHmac('sha256',secret).update('infinitepay-csrf-v1\0'+token).digest('base64url')},capabilities:['WORKER'],validForSeconds:900});
    assert.equal(await a.authorize(context('WORKER')),true);clock=new Date(clock.getTime()+2000);
    assert.equal(await a.authorize(context('WORKER')),false);
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),1);
});
test('capability is a bounded policy, not a reusable one-shot financial reservation',async()=>{
    const a=authorizer();await approve(a);
    assert.equal(await a.authorize(context('VERIFY_PAYMENT')),true);assert.equal(await a.authorize(context('VERIFY_PAYMENT')),true);
    assert.equal(await authorizer().authorize(context('VERIFY_PAYMENT')),false);
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),1);
});
test('audit failure during revocation or emergency stop still denies this process',async()=>{
    const a=authorizer(),grant=await approve(a);
    await db.raw("CREATE FUNCTION synthetic_stop_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC'; END $$");
    await db.raw('CREATE TRIGGER synthetic_stop_audit_failure BEFORE INSERT ON infinitepay_autorizacao_decisoes FOR EACH ROW EXECUTE FUNCTION synthetic_stop_audit_failure()');
    await assert.rejects(a.revoke({session,id:grant.id}));assert.equal(await a.authorize(context('WORKER')),false);
    assert.equal((await db('infinitepay_autorizacoes_producao').where({id:grant.id}).first()).revogado_em,null);
    await assert.rejects(a.emergencyStop({session}));await assert.rejects(approve(a));
    assert.equal(await authorizer().authorize(context('WORKER')),false);
});
test('revocation during an in-flight simulated check preserves its result but blocks further dispatch and delivery',async()=>{
    const a=authorizer(),grant=await approve(a);let service,dispatches=0,release;
    const pending=new Promise(resolve=>release=resolve);
    try {
        const [method]=await db('metodos_pagamento').insert({nome:'SYNTHETIC PIX',codigo:'PIX',tipo_financeiro:'PIX'}).returning('*');
        const [order]=await db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
            fluxo_pagamento:'INFINITEPAY',metodo_pagamento_id:method.id,valor_total:1}).returning('*');
        const [payment]=await db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-IN-FLIGHT',status:'INCERTA',
            valor_centavos:100,valid_until:'2050-01-01T00:00:00Z',credencial_id:credential.id,handle_snapshot:credential.handle}).returning('*');
        Object.assign(env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true'});
        service=await application(a,async()=>{dispatches++;await pending;
            return {status:200,json:async()=>({success:true,paid:true,amount:100,paid_amount:100,installments:1,capture_method:'pix'})};});
        await service.runtime.receiveEvent({event_type:'paid',order_nsu:payment.order_nsu,transaction_nsu:'SYNTHETIC-IN-FLIGHT-TXN',invoice_slug:'SYNTHETIC-IN-FLIGHT-SLUG'});
        await service.start({intervalMs:60000});
        for(let n=0;n<200 && dispatches===0;n++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(dispatches,1);assert.equal((await db('pagamentos').where({id:payment.id}).first()).status,'INCERTA');
        await a.revoke({session,id:grant.id});release();
        for(let n=0;n<200 && service.status().cycles===0;n++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(service.status().cycles>0);
        assert.equal((await db('pagamentos').where({id:payment.id}).first()).status,'PAGA');
        assert.equal((await db('outbox_eventos').where({pedido_id:order.id}).first()).status,'PENDENTE');
        assert.deepEqual(await service.runtime.processPending(),{events:0,deliveries:0,errors:0});assert.equal(dispatches,1);
        assert.equal(service.status().consumer,'unconfigured');
    }finally{release?.();await service?.stop();}
});
});
