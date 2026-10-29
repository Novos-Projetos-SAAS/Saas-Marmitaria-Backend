import {test,describe,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import {infinitepaySessionCsrf} from '../../src/utils/infinitepaySessionCsrf.js';
import {createProductionAuthorizer} from '../../src/services/productionAuthorizer.js';

describe('inactive production administrative API, synthetic only',{concurrency:false},()=>{
    let fixture,db,env,clock,secret,token,actor,authorizer,server,base,oldKey,routerFactory;
    const csrf=value=>infinitepaySessionCsrf(value,secret);
    const session=()=>({token,origin:'https://shop.invalid.test',csrf:csrf(token)});
    const make=()=>createProductionAuthorizer({db,env,now:()=>clock,sessionSecret:()=>secret});
    beforeEach(async()=>{
        ({createProductionControlRouter:routerFactory}=await import('../../src/routes/InfinitepayProductionControl.Routes.js'));
        fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();
        env=syntheticProductionEnvironment(testConnection());clock=new Date('2026-10-28T12:00:00Z');secret=randomBytes(32).toString('base64');
        oldKey=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
        await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
        const [role]=await db('niveis_acesso').insert({nome:'admin',descricao:'SYNTHETIC'}).returning('*');
        [actor]=await db('usuarios').insert({nome:'SYNTHETIC',email:'control-api@invalid.test',senha_hash:'SYNTHETIC',nivel_acesso_id:role.id}).returning('*');
        const permission=await db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();
        await db('permissoes_usuarios').insert({usuario_id:actor.id,permissao_id:permission.id});
        const [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-control',...encryptApiKey('SYNTHETIC_CONTROL_KEY','synthetic-control')}).returning('*');
        await db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
        const seconds=clock.getTime()/1000;token=jwt.sign({id:actor.id,iat:seconds,exp:seconds+3600},secret,{algorithm:'HS256'});
        authorizer=make();
        const app=express();app.set('trust proxy',(ip,hop)=>hop===0 && ['127.0.0.1','::ffff:127.0.0.1'].includes(ip));
        app.use(cookieParser());app.use('/control',routerFactory({authorizer}));
        server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port+'/control';
    });
    afterEach(async()=>{
        if(server)await new Promise(resolve=>server.close(resolve));
        if(oldKey===undefined)delete process.env.INFINITEPAY_ENCRYPTION_KEY;else process.env.INFINITEPAY_ENCRYPTION_KEY=oldKey;
        await fixture?.close();
    });
    async function request(path='',{method='GET',body,headers={}}={}) {
        const response=await fetch(base+path,{method,headers:{Cookie:'token='+token,Origin:'https://shop.invalid.test',
            'X-Infinitepay-CSRF':csrf(token),'X-Forwarded-Proto':'https',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
            ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
        return {status:response.status,cache:response.headers.get('cache-control'),text:await response.text()};
    }
    const approval=()=>request('/approvals',{method:'POST',body:{capabilities:['WORKER','VERIFY_PAYMENT']}});

    test('mounting the control API cannot grant permissions or authorize an unprivileged administrator',async()=>{
        await db('permissoes_usuarios').where({usuario_id:actor.id}).del();
        assert.equal((await approval()).status,403);
        assert.equal(Number((await db('permissoes_usuarios').count('* as n').first()).n),0);
        assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
    });
    test('status is authenticated, deny by default and never activates the runtime or database',async()=>{
        const response=await request();assert.equal(response.status,200);assert.equal(response.cache,'no-store');
        const data=JSON.parse(response.text).data;assert.equal(data.halted,false);assert.deepEqual(data.approvals,[]);
        assert.equal((await db('config_infinitepay').first()).ativo,false);
        assert.equal(env.INFINITEPAY_CHECKOUT_ENABLED,undefined);
    });
    test('approval, status and revocation persist decisions and preserve capability separation',async()=>{
        const created=await approval();assert.equal(created.status,201);const grant=JSON.parse(created.text).data;
        let state=JSON.parse((await request()).text).data;
        assert.deepEqual(state.approvals[0].effectiveCapabilities,['VERIFY_PAYMENT','WORKER']);
        assert.equal((await request('/revocations',{method:'POST',body:{id:grant.id}})).status,200);
        state=JSON.parse((await request()).text).data;assert.deepEqual(state.approvals[0].effectiveCapabilities,[]);
        assert.equal(state.approvals[0].revoked,true);
        assert.equal((await db('infinitepay_autorizacao_decisoes').where({operacao:'REVOKE',decisao:'ALLOW'})).length,1);
    });
    test('no JWT, invalid signature, expiry and inactive user are rejected even with matching csrf',async()=>{
        const seconds=clock.getTime()/1000;
        for(const value of ['',jwt.sign({id:actor.id,iat:seconds,exp:seconds+10},randomBytes(32).toString('base64')),
            jwt.sign({id:actor.id,iat:seconds-20,exp:seconds-1},secret)]) {
            assert.equal((await request('',{headers:{Cookie:'token='+value,'X-Infinitepay-CSRF':value?csrf(value):''}})).status,403);
        }
        await db('usuarios').where({id:actor.id}).update({ativo:false});assert.equal((await approval()).status,403);
    });
    test('missing or incorrect csrf, unauthorized Origin and insecure transport are rejected',async()=>{
        for(const headers of [{'X-Infinitepay-CSRF':''},{'X-Infinitepay-CSRF':'wrong'},{Origin:'https://evil.invalid.test'},
            {Origin:'http://shop.invalid.test'},{Origin:'null'},{'X-Forwarded-Proto':'http'}]) {
            assert.equal((await approvalWith(headers)).status,403);
        }
        async function approvalWith(headers){return request('/approvals',{method:'POST',body:{capabilities:['WORKER']},headers});}
    });
    test('rejects non-JSON, malformed JSON and caller-supplied authentication or environment',async()=>{
        assert.equal((await request('/approvals',{method:'POST',body:'capabilities=WORKER',headers:{'Content-Type':'text/plain'}})).status,415);
        assert.equal((await request('/approvals',{method:'POST',body:'{'})).status,400);
        for(const extra of [{session:session()},{database:'other'},{deploymentId:randomUUID()},{token}]) {
            assert.equal((await request('/approvals',{method:'POST',body:{capabilities:['WORKER'],...extra}})).status,400);
        }
    });
    test('invalid credential and recipient, excessive validity and unknown capabilities never create approval',async()=>{
        for(const body of [{capabilities:['WORKER'],credentialId:99999},{capabilities:['DELIVER_ORDER']},
            {capabilities:['WORKER'],validForSeconds:901},{capabilities:['UNRESTRICTED']}]) {
            assert.equal((await request('/approvals',{method:'POST',body})).status,403);
        }
        assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
    });
    test('concurrent HTTP approvals leave one effective grant, expiry does not renew it',async()=>{
        assert.deepEqual((await Promise.all([approval(),approval()])).map(value=>value.status),[201,201]);
        let state=JSON.parse((await request()).text).data;
        assert.equal(state.approvals.filter(row=>row.effectiveCapabilities.length).length,1);
        clock=new Date(clock.getTime()+301000);state=JSON.parse((await request()).text).data;
        assert.equal(state.approvals.filter(row=>row.effectiveCapabilities.length).length,0);
        assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),2);
    });
    test('emergency stop persists revocations and cannot be cleared by another approval',async()=>{
        await approval();assert.equal((await request('/emergency-stop',{method:'POST',body:{}})).status,200);
        const state=JSON.parse((await request()).text).data;assert.equal(state.halted,true);
        assert.deepEqual(state.approvals[0].effectiveCapabilities,[]);assert.equal((await approval()).status,403);
        const fresh=make();assert.deepEqual((await fresh.status({session:session()})).approvals,[]);
    });
    test('failed audit rolls back approval and response never exposes raw exception or secrets',async()=>{
        await db.raw("CREATE FUNCTION synthetic_api_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_CONTROL_KEY'; END $$");
        await db.raw('CREATE TRIGGER synthetic_api_audit_failure BEFORE INSERT ON infinitepay_autorizacao_decisoes FOR EACH ROW EXECUTE FUNCTION synthetic_api_audit_failure()');
        const response=await approval();assert.equal(response.status,503);
        for(const value of [token,csrf(token),secret,'SYNTHETIC_CONTROL_KEY'])assert.equal(response.text.includes(value),false);
        assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
    });
    test('status does not advertise tampered approval or invalid database as authorized',async()=>{
        const grant=JSON.parse((await approval()).text).data;
        await db('infinitepay_autorizacoes_producao').where({id:grant.id}).update({assinatura:'0'.repeat(64)});
        assert.deepEqual(JSON.parse((await request()).text).data.approvals[0].effectiveCapabilities,[]);
        await db('infinitepay_identidade_ambiente').where({id:1}).update({ambiente:'NAO_CONFIGURADO'});
        assert.equal((await request()).status,503);
    });
    test('csrf bootstrap needs only activation permission, authenticates without prior csrf and grants nothing',async()=>{
        const response=await request('/csrf',{headers:{'X-Infinitepay-CSRF':''}});assert.equal(response.status,200);
        assert.equal(JSON.parse(response.text).data.csrfToken,csrf(token));assert.equal(response.cache,'no-store');
        assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
        const permission=await db('permissoes').where({nome:'pagamentos.configurar'}).first();
        assert.equal(await db('permissoes_usuarios').where({usuario_id:actor.id,permissao_id:permission.id}).first(),undefined);
        for(const headers of [{Origin:'https://evil.invalid.test'},{Origin:''},{Cookie:'token=invalid'}])
            assert.equal((await request('/csrf',{headers})).status,403);
        await db('permissoes_usuarios').where({usuario_id:actor.id}).del();assert.equal((await request('/csrf')).status,403);
    });
    test('csrf bootstrap rejects expired session and inactive level',async()=>{
        const expired=jwt.sign({id:actor.id,iat:clock.getTime()/1000-20,exp:clock.getTime()/1000-1},secret);
        assert.equal((await request('/csrf',{headers:{Cookie:'token='+expired,'X-Infinitepay-CSRF':''}})).status,403);
        await db('niveis_acesso').where({id:actor.nivel_acesso_id}).update({ativo:false});assert.equal((await request('/csrf')).status,403);
    });
    test('administrative logout revokes the JWT durably and rejects reuse after restart',async()=>{
        await approval();assert.equal((await request('/session/end',{method:'POST',body:{}})).status,200);
        assert.equal((await request('/csrf')).status,403);assert.equal((await approval()).status,403);
        await assert.rejects(make().csrf({session:session()}));
        const stored=JSON.stringify(await db('infinitepay_sessoes_revogadas'));assert.equal(stored.includes(token),false);
        assert.equal(Number((await db('infinitepay_sessoes_revogadas').count('* as n').first()).n),1);
    });
    test('recovery needs explicit confirmation and correct generation; it never approves capabilities',async()=>{
        await approval();await request('/emergency-stop',{method:'POST',body:{}});
        const state=JSON.parse((await request()).text).data;
        for(const body of [{expectedGeneration:state.generation},{expectedGeneration:'999',confirmation:'RECUPERAR SEM ATIVAR CAPACIDADES'}])
            assert.equal((await request('/recovery',{method:'POST',body})).status,403);
        const response=await request('/recovery',{method:'POST',body:{expectedGeneration:state.generation,confirmation:'RECUPERAR SEM ATIVAR CAPACIDADES'}});
        assert.equal(response.status,200);assert.equal((await approval()).status,403);
        assert.deepEqual((await make().status({session:session()})).approvals,[]);
    });
    test('audit-only stop failure returns 503 with durable stop and no false success',async()=>{
        await approval();await db.raw("CREATE FUNCTION synthetic_api_stop_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET'; END $$");
        await db.raw('CREATE TRIGGER synthetic_api_stop_audit_failure BEFORE INSERT ON infinitepay_controle_acoes FOR EACH ROW EXECUTE FUNCTION synthetic_api_stop_audit_failure()');
        const response=await request('/emergency-stop',{method:'POST',body:{}});assert.equal(response.status,503);
        assert.equal(JSON.parse(response.text).code,'STOP_PERSISTED_AUDIT_PENDING');assert.equal(response.text.includes('SYNTHETIC_SECRET'),false);
        const state=JSON.parse((await request()).text).data;assert.equal(state.halted,true);assert.equal(state.auditPending,true);
    });
    test('audit-only session end failure returns 503 but the JWT remains durably revoked',async()=>{
        await approval();await db.raw("CREATE FUNCTION synthetic_api_end_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET'; END $$");
        await db.raw('CREATE TRIGGER synthetic_api_end_audit_failure BEFORE INSERT ON infinitepay_controle_acoes FOR EACH ROW EXECUTE FUNCTION synthetic_api_end_audit_failure()');
        const response=await request('/session/end',{method:'POST',body:{}});assert.equal(response.status,503);
        assert.equal(JSON.parse(response.text).code,'SESSION_ENDED_AUDIT_PENDING');assert.equal((await request('/csrf')).status,403);
        await assert.rejects(make().csrf({session:session()}));
    });
});
