import {test,before,after,describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import {request as httpRequest} from 'node:http';
import jwt from 'jsonwebtoken';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {configureProductionProxy,validateProductionEnvironment} from '../../src/config/infinitepayProduction.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import {logout} from '../../src/utils/logoutResponse.js';

describe('normal production server composition with isolated dependencies',{concurrency:false},()=>{
let fixture,db,env,service,server,base,compose,token,actor,oldEnvironment;
const secret=randomBytes(32).toString('base64'),origin='https://shop.invalid.test';
before(async()=>{
    ({initializeServerFinancial:compose}=await import('../../src/infinitepayServerComposition.js'));
    fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();env={...syntheticProductionEnvironment(testConnection()),JWT_SECRET:secret};
    await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
    oldEnvironment=Object.fromEntries(['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(key=>[key,process.env[key]]));
    process.env.INFINITEPAY_ENCRYPTION_KEY=randomBytes(32).toString('base64');delete process.env.INFINITEPAY_ENCRYPTION_KEYS;delete process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION;
    const [role]=await db('niveis_acesso').insert({nome:'admin',descricao:'SYNTHETIC'}).returning('*');
    [actor]=await db('usuarios').insert({nome:'SYNTHETIC',email:'composition@invalid.test',senha_hash:'NONE',nivel_acesso_id:role.id}).returning('*');
    const permission=await db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();
    await db('permissoes_usuarios').insert({usuario_id:actor.id,permissao_id:permission.id});
    const [credential]=await db('infinitepay_credenciais').insert({handle:'synthetic-composition',...encryptApiKey('SYNTHETIC_KEY','synthetic-composition')}).returning('*');
    await db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
    token=jwt.sign({id:actor.id},secret,{expiresIn:'1h'});
    const app=express();configureProductionProxy(app,validateProductionEnvironment(env));app.use(cookieParser(),express.json());
    app.post('/auth/logout',(req,res,next)=>(app.locals.infinitepayLogout || logout)(req,res,next));
    service=await compose({app,db,env,io:{to(){throw new Error('MUST_STAY_OFF');}},loadOrder:async()=>{throw new Error('MUST_STAY_OFF');},
        transport:async()=>{throw new Error('NO_REAL_TRANSPORT');}});
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await service?.stop();if(server)await new Promise(resolve=>server.close(resolve));for(const [key,value]of Object.entries(oldEnvironment || {})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fixture?.close();});
function request(path,{method='GET',body,csrf,cookie=token,proto='https'}={}) {
    return new Promise((resolve,reject)=>{
        const payload=body?JSON.stringify(body):undefined;
        const req=httpRequest(base+path,{method,headers:{Origin:origin,Host:'backend.invalid.test','X-Forwarded-For':'203.0.113.8',Cookie:'token='+cookie,'X-Forwarded-Proto':proto,
            ...(csrf?{'X-Infinitepay-CSRF':csrf}:{}),...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
            let data='';res.setEncoding('utf8');res.on('data',part=>{data+=part;});res.on('end',()=>resolve(new Response(data,{status:res.statusCode,headers:res.headers})));
        });req.on('error',reject);req.end(payload);
    });
}
const control='/pagamentos/controle-producao';
async function csrf() {const response=await request(control+'/csrf');assert.equal(response.status,200,await response.clone().text());return (await response.json()).data.csrfToken;}

test('real server composition installs prepared destination and protected control without activating or granting',async()=>{
    await service.start();assert.equal(service.status().running,false);assert.equal(service.status().consumer,'operational-adapter');
    assert.equal((await db('config_infinitepay').first()).ativo,false);
    const response=await request(control,{csrf:await csrf()});assert.equal(response.status,200,await response.text());assert.equal((await request(control,{cookie:''})).status,403);
    assert.equal((await request(control,{proto:'http'})).status,403);
    assert.equal(Number((await db('infinitepay_autorizacoes_producao').count('* as n').first()).n),0);
    assert.equal(Number((await db('permissoes_usuarios').count('* as n').first()).n),1);
});
test('mounted diagnostics require actor and csrf, report age/divergence and never expose provider secrets',async()=>{
    const response=await request(control+'/diagnostico',{csrf:await csrf()});assert.equal(response.status,200);
    const text=await response.text(),data=JSON.parse(text).data;
    assert.equal(data.commercialReady,false);assert.equal(data.financial.divergent,0);assert.equal(data.financial.uncertainOverdue,0);
    assert.equal(data.financial.oldestUncertainAt,null);assert.doesNotMatch(text,/SYNTHETIC_KEY|api_key|receipt_url|transaction_nsu/);
    assert.ok(Array.isArray(data.alerts));assert.equal(data.supervision.automaticRenewal,false);assert.deepEqual(data.supervision.missingCapabilities,[]);
    assert.equal((await request(control+'/diagnostico')).status,403);
});
test('worker awaits an explicit approval after boot; authenticated start and stop do not enable checkout',async()=>{
    env.INFINITEPAY_WORKER_ENABLED='true';env.INFINITEPAY_VERIFY_ENABLED='true';
    await service.start();assert.equal(service.status().running,false);
    const observed=await request(control+'/diagnostico',{csrf:await csrf()});const blocked=(await observed.json()).data;
    assert.ok(blocked.alerts.some(a=>a.code==='AUTHORIZATION_REQUIRED'));assert.ok(blocked.alerts.some(a=>a.code==='WORKER_STOPPED'));
    assert.equal((await request(control+'/worker/start',{method:'POST',body:{}})).status,403);
    const csrfToken=await csrf();
    assert.equal((await request(control+'/worker/start',{method:'POST',body:{},csrf:csrfToken})).status,503);
    const approval=await request(control+'/approvals',{method:'POST',csrf:csrfToken,body:{capabilities:['WORKER','VERIFY_PAYMENT']}});
    assert.equal(approval.status,201);const grant=(await approval.json()).data;
    assert.equal((await request(control+'/worker/start',{method:'POST',body:{},csrf:csrfToken})).status,200);
    assert.equal(service.status().running,true);assert.equal(await service.runtime.checkoutEnabled(),false);
    assert.equal((await request(control+'/entregas/1/recuperar',{method:'POST',body:{}})).status,403);
    assert.equal((await request(control+'/entregas/1/recuperar',{method:'POST',body:{},csrf:csrfToken})).status,503);
    assert.equal((await request(control+'/worker/stop',{method:'POST',body:{},csrf:csrfToken})).status,200);
    assert.equal(service.status().running,false);env.INFINITEPAY_WORKER_ENABLED='false';env.INFINITEPAY_VERIFY_ENABLED='false';
    assert.equal((await request(control+'/revocations',{method:'POST',csrf:csrfToken,body:{id:grant.id}})).status,200);
});
test('ordinary logout stays compatible; even a revoked financial grant requires durable session logout',async()=>{
    token=jwt.sign({id:actor.id,jti:'fresh-synthetic-session'},secret,{expiresIn:'1h'});
    let response=await request('/auth/logout',{method:'POST'});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/token=;/);
    const approval=await request(control+'/approvals',{method:'POST',csrf:await csrf(),body:{capabilities:['WORKER','VERIFY_PAYMENT']}});
    assert.equal(approval.status,201);const grant=(await approval.json()).data;
    assert.equal((await request(control+'/revocations',{method:'POST',csrf:await csrf(),body:{id:grant.id}})).status,200);
    response=await request('/auth/logout',{method:'POST'});assert.equal(response.status,409);assert.equal(response.headers.get('set-cookie'),null);
    assert.equal((await response.json()).code,'FINANCIAL_SESSION_CSRF_REQUIRED');
    response=await request('/auth/logout',{method:'POST',csrf:await csrf()});assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie'),/token=;/);
    assert.notEqual((await db('infinitepay_autorizacoes_producao').where({id:grant.id}).first()).revogado_em,null);
    assert.equal(Number((await db('infinitepay_sessoes_revogadas').count('* as n').first()).n),1);
    assert.equal((await request(control)).status,403);
});
test('removed financial permission does not prevent durable logout, but cannot bootstrap another grant',async()=>{
    token=jwt.sign({id:actor.id,jti:'removed-permission-session'},secret,{expiresIn:'1h'});
    const csrfToken=await csrf();
    assert.equal((await request(control+'/approvals',{method:'POST',csrf:csrfToken,body:{capabilities:['WORKER']}})).status,201);
    const permission=await db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();
    await db('permissoes_usuarios').where({usuario_id:actor.id,permissao_id:permission.id}).del();
    await db('usuarios').where({id:actor.id}).update({ativo:false});
    try {
        assert.equal((await request(control+'/csrf')).status,403);
        const response=await request(control+'/session/logout-csrf');assert.equal(response.status,200);
        const logoutCsrf=(await response.json()).data.csrfToken;
        assert.equal((await request('/auth/logout',{method:'POST',csrf:logoutCsrf})).status,200);
        assert.equal((await request(control,{csrf:logoutCsrf})).status,403);
    }finally{await db('usuarios').where({id:actor.id}).update({ativo:true});await db('permissoes_usuarios').insert({usuario_id:actor.id,permissao_id:permission.id});}
});
test('logout audit failure remains revoked and an explicit retry repairs the pending audit',async()=>{
    token=jwt.sign({id:actor.id,jti:'audit-retry-session'},secret,{expiresIn:'1h'});
    const csrfToken=await csrf();
    assert.equal((await request(control+'/approvals',{method:'POST',csrf:csrfToken,body:{capabilities:['WORKER']}})).status,201);
    const fail=query=>{if(query.sql.includes('insert into "infinitepay_controle_acoes"'))throw new Error('SYNTHETIC_AUDIT_UNAVAILABLE');};
    db.on('query',fail);
    try{assert.equal((await request('/auth/logout',{method:'POST',csrf:csrfToken})).status,503);}
    finally{db.removeListener('query',fail);}
    assert.equal((await request(control,{csrf:csrfToken})).status,403);
    const response=await request(control+'/session/logout-csrf');assert.equal(response.status,200);
    assert.equal((await request('/auth/logout',{method:'POST',csrf:(await response.json()).data.csrfToken})).status,200);
    assert.equal((await db('infinitepay_sessoes_revogadas').where({usuario_id:actor.id}).orderBy('revogado_em','desc').first()).auditoria_pendente,false);
});
test('expired JWT with financial history can clear its unusable cookie without reactivating any capability',async()=>{
    token=jwt.sign({id:actor.id,jti:'expired-financial-session'},secret,{expiresIn:'2s'});
    assert.equal((await request(control+'/approvals',{method:'POST',csrf:await csrf(),body:{capabilities:['WORKER']}})).status,201);
    await new Promise(resolve=>setTimeout(resolve,2100));
    const response=await request('/auth/logout',{method:'POST'});assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie'),/token=;/);assert.equal((await request(control+'/csrf')).status,403);
});
test('disabled server composition never constructs controls or queries a database',async()=>{
    const app=express(),db=()=>{throw new Error('DISABLED_MUST_NOT_QUERY');};
    const disabled=await compose({app,db,env:{INFINITEPAY_MODE:'disabled',INFINITEPAY_CHECKOUT_ENABLED:'false'}});
    await disabled.start();assert.equal(disabled.status().mode,'disabled');assert.equal(app.locals.infinitepayLogout,undefined);
});
});
