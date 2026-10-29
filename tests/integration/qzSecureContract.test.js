import {describe,test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticQzIdentity,createQzSigningFixture} from '../helpers/qzSigningFixture.js';
import {createQzIntegratedFixture} from '../helpers/qzIntegratedFixture.js';
import {createFrontendQzHarness} from '../helpers/qzFrontendHarness.js';
import {randomUUID,createHash} from 'node:crypto';

describe('protected QZ branch contract',{concurrency:false},()=>{
    let identity,wrongIdentity,f,client;
    before(async()=>{identity=await createSyntheticQzIdentity();wrongIdentity=await createSyntheticQzIdentity();});
    after(async()=>{await Promise.allSettled([identity?.close(),wrongIdentity?.close()]);});
    beforeEach(async()=>{f=await createQzSigningFixture(identity);});
    afterEach(async()=>{try{await client?.close();}finally{client=undefined;await f?.close();}});
    async function integrated() {await f.close();f=await createQzIntegratedFixture(identity);}
    test('secure contract bootstraps CSRF by POST and issues only a server-owned eligible document',async()=>{
        const request=await f.additionalServer({secureContract:true});
        try {
            const bootstrap=await request('/csrf',{});assert.equal(bootstrap.status,200);assert.match(bootstrap.data.csrfToken,/^[A-Za-z0-9_-]{43}$/);
            const response=await request('/documento',{stationId:f.station.id,pedidoId:f.doc.pedido_id});assert.equal(response.status,201);
            assert.equal(response.data.documentId,f.doc.id);assert.equal(response.data.params.data[0].data,f.doc.params.data[0].data);
        }finally{await request.close();}
    });
    test('real adapted frontend and branch routes sign only server-issued data and the fake Tray verifies it',async()=>{
        await integrated();const doc=await f.document({online:true,status:'PAGA',verified:true});
        client=await createFrontendQzHarness({f,identity,document:doc,integrated:true});
        assert.equal(await client.print('<script>UNAUTHORIZED BROWSER HTML</script>'),true);assert.equal(client.state.acceptedPrints,1);
        assert.equal(client.state.verifiedSignatures,2);assert.equal(client.state.csrfCalls,1);assert.equal(f.legacyCalls,0);
        const row=await f.db('qz_proto_intencoes').where({documento_id:doc.id}).first();assert.equal(row.estado,'ASSINADA');
    });
    test('secure mode does not expose legacy hash-only or alias endpoints even without a session',async()=>{
        await integrated();const token=f.session.token;f.useToken('');
        assert.equal((await f.secureRequest('/assinar',{request:'a'.repeat(64)})).status,403);
        f.useToken(token);await f.secureBootstrap();
        assert.equal((await f.secureRequest('/assinar',{request:'a'.repeat(64)})).status,400);
        assert.equal((await f.secureRequest('/sign',{request:'a'.repeat(64)})).status,404);
        assert.equal((await f.secureRequest('/csrf',undefined,{method:'GET'})).status,404);assert.equal(f.legacyCalls,0);
    });
    test('legacy and default modes never reach a legacy signer even inside the isolated fixture',async()=>{
        await integrated();const reference=await f.createProtectedServer({runtime:null});
        try {
            f.qzMode=undefined;assert.equal((await reference('/assinar',{request:'x'})).status,503);
            f.qzMode='legacy';assert.equal((await reference('/assinar',{request:'x'})).status,503);
            f.qzMode='secure-test';assert.notEqual((await reference('/assinar',{request:'x'})).text,'LEGACY_REFERENCE');
            f.qzMode='unknown';assert.equal((await reference('/assinar',{request:'x'})).status,503);assert.equal(f.legacyCalls,0);
        }finally{await reference.close();}
    });
    test('production refuses a genuine protected test runtime and cannot construct one with a production profile',async()=>{
        await integrated();const request=await f.createProtectedServer({environment:'production'});
        try{assert.equal((await request('/assinar',{request:'x'})).status,503);assert.equal(f.signCalls,0);assert.equal(f.legacyCalls,0);}
        finally{await request.close();}
        await assert.rejects(f.anotherSecureRuntime({env:{NODE_ENV:'production',QZ_SIGNING_MODE:'secure-test'}}));
    });
    test('installed protected runtime cannot expose legacy when its mode flag was omitted',async()=>{
        await integrated();f.qzMode=undefined;assert.equal((await f.secureRequest('/assinar',{request:'x'})).status,503);assert.equal(f.legacyCalls,0);
    });
    test('a router that selected protection cannot reopen legacy after configuration disappears',async()=>{
        await integrated();assert.equal((await f.secureRequest('/assinar',{request:'x'})).status,400);
        for(const mode of [undefined,'legacy']){f.qzMode=mode;assert.equal((await f.secureRequest('/assinar',{request:'x'})).status,503);}
        assert.equal(f.legacyCalls,0);
    });
    test('flag alone, missing runtime and forged runtime cannot activate the signer or call legacy',async()=>{
        await integrated();for(const runtime of [null,{router:(req,res)=>res.send('UNSAFE')}]) {
            const request=await f.createProtectedServer({runtime});
            try{assert.equal((await request('/assinar',{request:'a'.repeat(64)})).status,503);}finally{await request.close();}
        }assert.equal(f.legacyCalls,0);assert.equal(f.signCalls,0);
        await assert.rejects(f.anotherSecureRuntime({signDigest:undefined}));await assert.rejects(f.anotherSecureRuntime({certificate:''}));
    });
    for(const condition of ['AGUARDANDO','INCERTA'])test('adapted client cannot sign unpaid '+condition,async()=>{
        await integrated();const doc=await f.document({online:true,status:condition});client=await createFrontendQzHarness({f,identity,document:doc,integrated:true});
        await assert.rejects(client.print());assert.equal(f.signCalls,0);assert.equal(f.legacyCalls,0);
    });
    for(const condition of ['session','permission','csrf','origin','certificate','missing-certificate','missing-station'])test('integrated path denies '+condition,async()=>{
        await integrated();if(condition==='session')f.useToken(f.token({expired:true}));
        if(condition==='permission')await f.db('permissoes_usuarios').where({usuario_id:f.actor.id}).del();
        client=await createFrontendQzHarness({f,identity,integrated:true,
            presentedCertificate:condition==='certificate'?wrongIdentity.cert:condition==='missing-certificate'?'':identity.cert,
            stationId:condition==='missing-station'?'':f.station.id,
            headers:condition==='csrf'?{'X-Infinitepay-CSRF':'X'.repeat(43)}:condition==='origin'?{Origin:'https://evil.invalid.test'}:{}});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,0);assert.equal(f.legacyCalls,0);
    });
    for(const condition of ['hash','document','printer','recipient'])test('protected backend independently rejects substituted '+condition,async()=>{
        await integrated();client=await createFrontendQzHarness({f,identity,integrated:true,mutate:(body,call)=>{
            if(call!=='print')return body;if(condition==='hash')return {...body,request:'a'.repeat(64)};
            if(condition==='document')return {...body,documentId:randomUUID()};
            const message=JSON.parse(body.message);if(condition==='printer')message.params.printer={name:'OTHER'};else message.params.data[0].data+='<p>OTHER RECIPIENT</p>';
            const changed=JSON.stringify(message);return {...body,message:changed,request:createHash('sha256').update(changed).digest('hex')};
        }});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.legacyCalls,0);
    });
    test('server document issuance is idempotent under concurrent requests and cannot be rebound to another station',async()=>{
        await integrated();await f.secureBootstrap();
        const body={stationId:f.station.id,pedidoId:f.doc.pedido_id},responses=await Promise.all([f.secureRequest('/documento',body),f.secureRequest('/documento',body)]);
        assert.ok(responses.every(row=>row.status===201));assert.equal(responses[0].data.documentId,responses[1].data.documentId);
        const [station]=await f.db('qz_proto_estacoes').insert({id:randomUUID(),usuario_id:f.actor.id,impressora:f.station.impressora}).returning('*');
        assert.equal((await f.secureRequest('/documento',{...body,stationId:station.id})).status,403);
        assert.equal(Number((await f.db('qz_proto_documentos').where({pedido_id:body.pedidoId}).count('* as n').first()).n),1);
    });
    test('unapproved browser fields cannot create an approved document',async()=>{
        await integrated();await f.secureBootstrap();const response=await f.secureRequest('/documento',{stationId:f.station.id,pedidoId:f.doc.pedido_id,html:'UNTRUSTED'});
        assert.equal(response.status,400);assert.equal(f.signCalls,0);
    });
    test('document endpoint generates a new approved document from server order data without accepting HTML',async()=>{
        await integrated();const method=await f.db('metodos_pagamento').where({codigo:'DINHEIRO'}).first(),size=await f.db('tamanhos_marmitas').first();
        const [order]=await f.db('pedidos').insert({nome_cliente:'SERVER SOURCE',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',metodo_pagamento_id:method.id,valor_total:1}).returning('*');
        await f.db('itens_pedido').insert({pedido_id:order.id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:1,subtotal:1,nome_item_snapshot:'SERVER ITEM'});
        client=await createFrontendQzHarness({f,identity,document:{pedido_id:order.id,html:'BROWSER DATA IGNORED'},integrated:true});
        assert.equal(await client.print(),true);assert.equal(client.state.acceptedPrints,1);
        const doc=await f.db('qz_proto_documentos').where({pedido_id:order.id}).first();assert.ok(doc.params.data[0].data.includes('SERVER SOURCE'));
        assert.equal(doc.params.data[0].data.includes('BROWSER DATA IGNORED'),false);assert.equal(f.legacyCalls,0);
    });
    test('adapted client cannot print the same original document twice, including after backend restart',async()=>{
        await integrated();client=await createFrontendQzHarness({f,identity,integrated:true});assert.equal(await client.print(),true);await assert.rejects(client.print());
        await client.close();await f.restart();f.secureRequest=await f.createProtectedServer();
        client=await createFrontendQzHarness({f,identity,integrated:true});await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);
        const rows=await f.db('qz_proto_intencoes').where({documento_id:f.doc.id});assert.equal(rows.length,1);assert.equal(rows[0].estado,'ASSINADA');assert.equal(f.legacyCalls,0);
    });
    test('lost response after signing remains durably blocked without anonymous fallback or a second print intent',async()=>{
        await integrated();client=await createFrontendQzHarness({f,identity,integrated:true,afterSign:({call})=>{if(call==='print')throw new Error('SYNTHETIC_TIMEOUT');}});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(client.state.signCalls,2);
        await client.close();await f.restart();f.secureRequest=await f.createProtectedServer();
        client=await createFrontendQzHarness({f,identity,integrated:true});await assert.rejects(client.print());
        assert.equal(Number((await f.db('qz_proto_intencoes').where({documento_id:f.doc.id}).count('* as n').first()).n),1);assert.equal(f.legacyCalls,0);
    });
    for(const condition of ['audit','crypto','bad-signature','revocation','changed-recipient'])test('integrated signer fails closed for '+condition,async()=>{
        await integrated();if(condition==='audit')await f.failAudit('SIGN_CLAIMED');if(condition==='crypto')f.signFailure=true;
        client=await createFrontendQzHarness({f,identity,integrated:true,corruptSignature:condition==='bad-signature',afterPrepare:async({call})=>{
            if(call!=='print')return;
            if(condition==='revocation')await f.db('qz_proto_estacoes').where({id:f.station.id}).update({ativo:false});
            if(condition==='changed-recipient')await f.db('pedidos').where({id:f.doc.pedido_id}).update({nome_cliente:'CHANGED AFTER APPROVAL'});
        }});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.legacyCalls,0);
        assert.equal(client.logs.join('\n').includes('SYNTHETIC_PRIVATE_SECRET'),false);
    });
    for(const stage of ['document','audit','commit'])test('no signature escapes when expiry happens during final '+stage,async()=>{
        await f.bootstrap();const body=f.command('print'),prepared=await f.request('/prepare',body);assert.equal(prepared.status,201);
        let cryptography=false,advanced=false;f.onSign=()=>{cryptography=true;};
        const delayed=(result,query)=>{
            if(!cryptography || advanced)return;
            if(stage==='document' && query.sql.startsWith('select') && query.sql.includes('qz_proto_documentos') ||
                stage==='audit' && query.sql.includes('insert into "qz_proto_auditoria"') && query.bindings?.includes('SIGNED') ||
                stage==='commit' && /^COMMIT/.test(query.sql)) {advanced=true;f.advance(16000);}
        };
        const commitQuery=query=>{if(stage==='commit')delayed(undefined,query);};
        f.db.on('query-response',delayed);f.db.on('query',commitQuery);let response;
        try{response=await f.request('/sign',{intentId:prepared.data.intentId,request:body.request});}
        finally{f.db.removeListener('query-response',delayed);f.db.removeListener('query',commitQuery);}
        assert.equal(advanced,true);assert.equal(response.status,403);assert.equal(f.signCalls,1);
        assert.ok(['CONSUMIDA','ASSINADA'].includes((await f.db('qz_proto_intencoes').where({id:prepared.data.intentId}).first()).estado));
    });
});
