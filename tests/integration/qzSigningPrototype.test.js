import {test,describe,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

describe('isolated QZ signing protection with disposable synthetic identity',{concurrency:false},()=>{
    let identity,f,makeFixture;
    before(async()=>{const helpers=await import('../helpers/qzSigningFixture.js');identity=await helpers.createSyntheticQzIdentity();makeFixture=helpers.createQzSigningFixture;});
    after(async()=>{await identity?.close();});
    beforeEach(async()=>{f=await makeFixture(identity);});
    afterEach(async()=>{await f?.close();});
    const digest=raw=>createHash('sha256').update(raw).digest('hex');
    async function prepared(call='printers.find',doc=f.doc) {
        await f.bootstrap();const body=f.command(call,doc),response=await f.request('/prepare',body);
        assert.equal(response.status,201);return {body,id:response.data.intentId};
    }
    test('prototype never mounts or imports into operational composition and grants no permissions',async()=>{
        for(const name of ['app.js','server.js','routes/Qz.Routes.js','controllers/Qz.Controller.js'])
            assert.equal((await readFile(new URL('../../src/'+name,import.meta.url),'utf8')).includes('qzSigningPrototype'),false);
        await f.db('permissoes_usuarios').where({usuario_id:f.actor.id}).del();
        assert.equal((await f.request('/csrf',undefined,{method:'GET'})).status,403);assert.equal(f.signCalls,0);
        assert.equal(Number((await f.db('permissoes_usuarios').count('* as n').first()).n),0);
    });
    test('authorized configured discovery signs the original SHA256 hex string by RSA-SHA512',async()=>{
        const {body,id}=await prepared();const response=await f.request('/sign',{intentId:id,request:body.request});
        assert.equal(response.status,200);assert.match(response.text,/^[A-Za-z0-9+/]+={0,2}$/);
        assert.equal(identity.verify(body.request,response.text),true);assert.equal(identity.verify(body.message,response.text),false);
        assert.equal(f.signCalls,1);assert.equal((await f.db('qz_proto_intencoes').first()).estado,'ASSINADA');
        assert.equal(response.headers['cache-control'],'no-store');
    });
    test('authorized server-approved print is bound to order, station, document and exact parameters',async()=>{
        const {body,id}=await prepared('print');const response=await f.request('/sign',{intentId:id,request:body.request});
        assert.equal(response.status,200);assert.equal(identity.verify(body.request,response.text),true);assert.equal(f.signCalls,1);
        const again=f.command('print');f.advance(1);again.message=JSON.stringify({...JSON.parse(again.message),timestamp:f.clock.getTime()});again.request=digest(again.message);
        assert.equal((await f.request('/prepare',again)).status,409);
    });
    test('missing authentication, wrong signature and expired JWT reject even with a matching synthetic csrf',async()=>{
        for(const token of ['',f.token({wrongSecret:true}),f.token({expired:true})]) {
            f.useToken(token);const response=await f.request('/prepare',f.command());assert.equal(response.status,403);
        }
        assert.equal(f.signCalls,0);
    });
    test('inactive user, inactive role and removed explicit permission block signing without admin bypass',async()=>{
        await f.bootstrap();const body=f.command();
        for(const [table,column] of [['usuarios','ativo'],['niveis_acesso','ativo']]) {
            const id=table==='usuarios'?f.actor.id:f.actor.nivel_acesso_id;await f.db(table).where({id}).update({[column]:false});
            assert.equal((await f.request('/prepare',body)).status,403);await f.db(table).where({id}).update({[column]:true});
        }
        await f.db('permissoes_usuarios').where({usuario_id:f.actor.id}).del();assert.equal((await f.request('/prepare',body)).status,403);
        assert.equal(f.signCalls,0);
    });
    test('unauthorized Origin, absent csrf and csrf from another session are denied',async()=>{
        await f.bootstrap();for(const headers of [{Origin:'https://evil.invalid.test'},{Origin:'null'},{Origin:''},{'X-Infinitepay-CSRF':''},{'X-Infinitepay-CSRF':'A'.repeat(43)}])
            assert.equal((await f.request('/prepare',f.command(),{headers})).status,403);
        assert.equal(f.signCalls,0);
    });
    test('a hash alone cannot be authorized and arbitrary QZ device/file/network operations are denied',async()=>{
        await f.bootstrap();assert.equal((await f.request('/prepare',{stationId:f.station.id,request:'a'.repeat(64)})).status,400);
        for(const call of ['file.write','usb.sendData','networking.devices','serial.openPort','printers.clearQueue','print-anything']) {
            const body=f.command();body.message=JSON.stringify({call,params:{},timestamp:f.clock.getTime()});body.request=digest(body.message);
            assert.equal((await f.request('/prepare',body)).status,403);
        }
        assert.equal(f.signCalls,0);
    });
    test('digest mismatch, duplicate envelope keys, stale/future timestamps and malformed input reject safely',async()=>{
        await f.bootstrap();
        for(const message of ['not-json','{"call":"file.write","call":"printers.find","params":{"query":"SYNTHETIC_PRINTER"},"timestamp":1}',
            JSON.stringify({call:'printers.find',params:{query:f.station.impressora},timestamp:f.clock.getTime()-61000}),
            JSON.stringify({call:'printers.find',params:{query:f.station.impressora},timestamp:f.clock.getTime()+61000})]) {
            const response=await f.request('/prepare',{stationId:f.station.id,message,request:digest(message)});assert.ok([400,403].includes(response.status));
        }
        assert.equal((await f.request('/prepare',{...f.command(),request:'0'.repeat(64)})).status,400);
        assert.equal((await f.request('/prepare',{...f.command(),session:{token:f.session.token}})).status,400);assert.equal(f.signCalls,0);
    });
    test('changing the destination, approved document or HTML cannot turn the service into a generic signer',async()=>{
        await f.bootstrap();const body=f.command('print');
        for(const mutate of [params=>{params.printer={name:'OTHER'};},params=>{params.data[0].data='<html>SYNTHETIC_UNAUTHORIZED</html>';},
            params=>{params.data[0].flavor='file';params.data[0].data='file:///private';},params=>{params.options.copies=10;}]) {
            const command=JSON.parse(body.message);mutate(command.params);const raw=JSON.stringify(command);
            assert.equal((await f.request('/prepare',{...body,message:raw,request:digest(raw)})).status,403);
        }
        assert.equal((await f.request('/prepare',{...body,stationId:randomUUID()})).status,403);assert.equal(f.signCalls,0);
    });
    test('unpaid or uncertain online orders cannot be signed, including PAGA without independent evidence',async()=>{
        await f.bootstrap();for(const status of ['AGUARDANDO','INCERTA','FALHOU','PAGA','ESTORNADA']) {
            const doc=await f.document({online:true,status,verified:false});assert.equal((await f.request('/prepare',f.command('print',doc))).status,403);
        }
        assert.equal(f.signCalls,0);
    });
    test('verified online payment and legacy money/debit remain eligible only for approved documents',async()=>{
        await f.bootstrap();for(const options of [{online:true,status:'PAGA',verified:true},{online:false,method:'DINHEIRO'},{online:false,method:'CARTAO_DEBITO'}]) {
            f.advance(1);const doc=await f.document(options),body=f.command('print',doc),created=await f.request('/prepare',body);assert.equal(created.status,201);
            assert.equal((await f.request('/sign',{intentId:created.data.intentId,request:body.request})).status,200);
        }
        assert.equal(f.signCalls,3);
    });
    test('same digest, consumed intent, expired intent and another session cannot be reused',async()=>{
        const {body,id}=await prepared();assert.equal((await f.request('/prepare',body)).status,409);
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,200);
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,409);assert.equal(f.signCalls,1);
        f.advance(1);const next=f.command(),created=await f.request('/prepare',next);assert.equal(created.status,201);
        f.advance(16000);assert.equal((await f.request('/sign',{intentId:created.data.intentId,request:next.request})).status,409);
        f.useToken(f.token());await f.bootstrap();assert.equal((await f.request('/sign',{intentId:created.data.intentId,request:next.request})).status,403);
    });
    test('two service instances can consume a durable intent only once under concurrent requests',async()=>{
        const {body,id}=await prepared(),other=await f.anotherService();
        const input={session:f.session,intentId:id,request:body.request};
        const results=await Promise.allSettled([f.service.sign(input),other.sign(input)]);
        assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.signCalls,1);
        assert.equal((await f.db('qz_proto_intencoes').where({id}).first()).estado,'ASSINADA');
    });
    test('durable per-user quota and HTTP abuse limit reject excess requests without using the key',async()=>{
        await f.bootstrap();const service=await f.anotherService({maxCalls:3});
        for(let i=0;i<3;i++){f.advance(1);await service.prepare({session:f.session,...f.command()});}
        f.advance(1);await assert.rejects(service.prepare({session:f.session,...f.command()}),error=>error.statusCode===429);
        const limited=await f.additionalServer({globalLimit:2});
        try{const statuses=[];for(let i=0;i<3;i++)statuses.push((await limited('/csrf',undefined,{method:'GET'})).status);assert.equal(statuses[2],429);}
        finally{await limited.close();}assert.equal(f.signCalls,0);
    });
    test('signer errors never expose private material and cannot make the consumed intent retryable',async()=>{
        const {body,id}=await prepared();f.signFailure=true;
        const response=await f.request('/sign',{intentId:id,request:body.request});assert.equal(response.status,503);assert.equal(response.text.includes('SYNTHETIC_PRIVATE_SECRET'),false);
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,409);assert.equal(f.signCalls,1);
    });
    test('failure of mandatory audit before signing prevents any use of the key',async()=>{
        const {body,id}=await prepared();await f.failAudit('SIGN_CLAIMED');
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,503);assert.equal(f.signCalls,0);
    });
    test('audit failure after cryptography withholds the signature and keeps the durable claim consumed',async()=>{
        const {body,id}=await prepared();await f.failAudit('SIGNED');
        const response=await f.request('/sign',{intentId:id,request:body.request});assert.equal(response.status,503);
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,409);assert.equal(f.signCalls,1);
        assert.equal((await f.db('qz_proto_intencoes').where({id}).first()).estado,'CONSUMIDA');
    });
    test('audit stores only fixed metadata and no request, HTML, credentials, signature or exception text',async()=>{
        const {body,id}=await prepared('print'),signed=await f.request('/sign',{intentId:id,request:body.request});
        const audit=JSON.stringify(await f.db('qz_proto_auditoria'));
        for(const value of [body.message,f.doc.params.data[0].data,f.session.token,f.session.csrf,signed.text,'SYNTHETIC_PRIVATE_SECRET'])assert.equal(audit.includes(value),false);
    });
    test('compatibility harness captures the actual QZ 2.2.6 hash callback and verifies find/print with a fake WebSocket',async()=>{
        const {runQzClientHarness}=await import('../helpers/qzClientHarness.js');await f.bootstrap();
        const result=await runQzClientHarness({f,identity});assert.equal(result.signatures,2);assert.equal(result.printRequests,1);assert.equal(result.physicalPrinting,false);
    });
    test('test-only guard refuses H4, remote hosts and public schema before any SQL',async()=>{
        const {createQzSigningPrototype}=await import('../../src/homologation/qzSigningPrototype.js');let queries=0;
        for(const [host,database,searchPath] of [['127.0.0.1','infinitepay_credit_homologacao',[f.schema]],['remote.invalid.test','infinitepay_phase1_test',[f.schema]],['127.0.0.1','infinitepay_phase1_test',['public']]]) {
            const db={client:{config:{connection:{host,database},searchPath}},raw:()=>{queries++;}};
            await assert.rejects(createQzSigningPrototype({db}));
        }
        assert.equal(queries,0);
        const host=f.db.client.config.connection.host;f.db.client.config.connection.host='remote.invalid.test';
        try{assert.equal((await f.request('/csrf',undefined,{method:'GET'})).status,503);}finally{f.db.client.config.connection.host=host;}
        assert.equal(f.signCalls,0);
    });
    test('durably revoked session cannot consume a previously authorized intent',async()=>{
        const {body,id}=await prepared(),marker=await f.db('infinitepay_identidade_ambiente').where({id:1}).first();
        await f.db('infinitepay_sessoes_revogadas').insert({implantacao_id:marker.identidade,token_hash:digest('infinitepay-admin-session-v1\0'+f.session.token),usuario_id:f.actor.id,revogado_em:f.clock,expira_em:new Date(f.clock.getTime()+3600000)});
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,403);assert.equal(f.signCalls,0);
    });
    test('permission revocation after cryptography withholds the signature without reopening the claim',async()=>{
        const {body,id}=await prepared();f.onSign=()=>f.db('permissoes_usuarios').where({usuario_id:f.actor.id}).del();
        const response=await f.request('/sign',{intentId:id,request:body.request});assert.equal(response.status,403);assert.equal(f.signCalls,1);
        assert.equal((await f.db('qz_proto_intencoes').where({id}).first()).estado,'CONSUMIDA');assert.equal(response.text.includes('SYNTHETIC_PRIVATE_SECRET'),false);
    });
    test('wrong content type, oversized body and malformed JSON never use the key',async()=>{
        await f.bootstrap();
        assert.equal((await f.request('/prepare',f.command(),{headers:{'Content-Type':'text/plain'}})).status,415);
        assert.equal((await f.request('/prepare',{...f.command(),message:'X'.repeat(90000)})).status,413);
        assert.equal((await f.request('/prepare','not an object')).status,400);assert.equal(f.signCalls,0);
    });
    test('a claim expiring while authorization queries wait cannot reach the key',async()=>{
        const {body,id}=await prepared();let claimed=false,advanced=false;
        const delay=(result,query)=>{
            if(query.sql.includes('insert into "qz_proto_auditoria"') && query.bindings?.includes('SIGN_CLAIMED'))claimed=true;
            else if(claimed && !advanced && query.sql.startsWith('select') && query.sql.includes('qz_proto_estacoes')){advanced=true;f.advance(16000);}
        };
        f.db.on('query-response',delay);
        let response;
        try{response=await f.request('/sign',{intentId:id,request:body.request});}
        finally{f.db.removeListener('query-response',delay);}
        assert.equal(advanced,true);assert.equal(f.signCalls,0);assert.equal(response.status,409);assert.equal((await f.db('qz_proto_intencoes').where({id}).first()).estado,'CONSUMIDA');
    });
});
