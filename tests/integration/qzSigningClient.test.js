import {describe,test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createSyntheticQzIdentity,createQzSigningFixture,syntheticQz} from '../helpers/qzSigningFixture.js';
import {createFrontendQzHarness} from '../helpers/qzFrontendHarness.js';

describe('synthetic integration of the unchanged QZ frontend and protected signer',{concurrency:false,timeout:120000},()=>{
    let identity,wrongIdentity,f,client;
    before(async()=>{identity=await createSyntheticQzIdentity();wrongIdentity=await createSyntheticQzIdentity();});
    after(async()=>{await Promise.allSettled([identity?.close(),wrongIdentity?.close()]);});
    beforeEach(async()=>{f=await createQzSigningFixture(identity);});
    afterEach(async()=>{try{await client?.close();}finally{client=undefined;await f?.close();}});
    const digest=value=>createHash('sha256').update(value).digest('hex');
    async function prepare(doc=f.doc){await f.bootstrap();const body=f.command('print',doc),response=await f.request('/prepare',body);assert.equal(response.status,201);return {body,id:response.data.intentId};}

    test('an approved document cannot be reassigned to another eligible order after intent creation',async()=>{
        const {body,id}=await prepare(),method=await f.db('metodos_pagamento').where({codigo:'DINHEIRO'}).first();
        const [other]=await f.db('pedidos').insert({nome_cliente:'SYNTHETIC OTHER',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',metodo_pagamento_id:method.id,valor_total:1}).returning('*');
        await f.db('qz_proto_documentos').where({id:f.doc.id}).update({pedido_id:other.id});
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,403);assert.equal(f.signCalls,0);
    });
    test('a changed order recipient invalidates the persisted approved document before signing',async()=>{
        const {body,id}=await prepare();await f.db('pedidos').where({id:f.doc.pedido_id}).update({nome_cliente:'SYNTHETIC OTHER RECIPIENT'});
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,403);assert.equal(f.signCalls,0);
    });
    test('unchanged qzService signs server-derived paid order HTML through authenticated HTTPS and the fake Tray verifies it',async()=>{
        const doc=await f.document({online:true,status:'PAGA',verified:true});client=await createFrontendQzHarness({f,identity,document:doc});
        assert.equal(await client.print(),true);assert.equal(client.state.acceptedPrints,1);assert.equal(client.state.verifiedSignatures,2);
        assert.equal(client.state.csrfCalls,1);assert.equal(client.state.physicalPrinting,false);
        const intents=await f.db('qz_proto_intencoes').orderBy('criado_em');assert.equal(intents.length,2);assert.ok(intents.every(row=>row.estado==='ASSINADA'));
        assert.equal(intents.find(row=>row.chamada==='print').documento_id,doc.id);
        const stored=JSON.stringify(await f.db('qz_proto_auditoria')),logged=client.logs.join('\n');
        for(const privateValue of [f.session.token,f.session.csrf,doc.params.data[0].data,'SYNTHETIC_PRIVATE_SECRET']){
            assert.equal(stored.includes(privateValue),false);assert.equal(logged.includes(privateValue),false);
        }
    });
    for(const status of ['AGUARDANDO','INCERTA'])test('unchanged frontend cannot obtain a print signature for online '+status,async()=>{
        const doc=await f.document({online:true,status});client=await createFrontendQzHarness({f,identity,document:doc});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(await f.db('qz_proto_intencoes').where({chamada:'print'}).first(),undefined);
    });
    for(const fault of ['permission','expired','csrf','origin'])test('complete client path denies '+fault+' without an accepted QZ operation',async()=>{
        if(fault==='permission')await f.db('permissoes_usuarios').where({usuario_id:f.actor.id}).del();
        if(fault==='expired')f.useToken(f.token({expired:true}));
        const headers=fault==='csrf'?{'X-Infinitepay-CSRF':'X'.repeat(43)}:fault==='origin'?{Origin:'https://evil.invalid.test'}:{};
        client=await createFrontendQzHarness({f,identity,headers});await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,0);
    });
    for(const fault of ['hash','preimage','document','recipient','printer'])test('complete client path rejects substituted '+fault,async()=>{
        client=await createFrontendQzHarness({f,identity,mutate:(body,call)=>{
            if(call!=='print')return body;
            if(fault==='hash')return {...body,request:'0'.repeat(64)};
            if(fault==='document')return {...body,documentId:randomUUID()};
            const command=JSON.parse(body.message);
            if(fault==='printer')command.params.printer={host:'192.0.2.1',port:9100};
            else command.params.data[0].data+='<p>UNAUTHORIZED RECIPIENT</p>';
            const message=JSON.stringify(command);return {...body,message,request:fault==='preimage'?body.request:digest(message)};
        }});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,1);
    });
    test('sending arbitrary HTML through the original print API cannot replace the server-owned document',async()=>{
        client=await createFrontendQzHarness({f,identity});await assert.rejects(client.print('<html>UNAUTHORIZED</html>'));
        assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,1);
    });
    test('signature without a persisted intention is refused',async()=>{
        await f.bootstrap();assert.equal((await f.request('/sign',{intentId:randomUUID(),request:'a'.repeat(64)})).status,403);assert.equal(f.signCalls,0);
    });
    test('two clients requesting the same approved document cannot obtain two print signatures',async()=>{
        let release,reached;const entered=new Promise(accept=>reached=accept),gate=new Promise(accept=>release=accept);
        client=await createFrontendQzHarness({f,identity,afterPrepare:async({call})=>{if(call==='print'){reached();await gate;}}});
        await client.connect();const first=client.print();await Promise.race([entered,first.then(()=>{throw new Error('Expected prepared print intent.');})]);
        try{await assert.rejects(client.print());}finally{release();}
        assert.equal(await first,true);assert.equal(client.state.acceptedPrints,1);assert.equal(Number((await f.db('qz_proto_intencoes').where({chamada:'print'}).count('* as n').first()).n),1);
    });
    test('lost sign response never prints or retries automatically and the persisted claim survives server restart',async()=>{
        client=await createFrontendQzHarness({f,identity,afterSign:({call})=>{if(call==='print')throw new Error('SYNTHETIC_TIMEOUT');}});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(client.state.signCalls,2);
        await client.close();await f.restart();client=await createFrontendQzHarness({f,identity});await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);
        const rows=await f.db('qz_proto_intencoes').where({chamada:'print'});assert.equal(rows.length,1);assert.equal(rows[0].estado,'ASSINADA');
        assert.equal(Number((await f.db('qz_proto_auditoria').where({intencao_id:rows[0].id,codigo:'SIGNED'}).count('* as n').first()).n),1);
    });
    test('unconsumed valid intent can complete once after restarting only the synthetic backend',async()=>{
        const {body,id}=await prepare();await f.restart();const signed=await f.request('/sign',{intentId:id,request:body.request});
        assert.equal(signed.status,200);assert.equal(identity.verify(body.request,signed.text),true);
        assert.equal((await f.request('/sign',{intentId:id,request:body.request})).status,409);assert.equal(f.signCalls,1);
    });
    test('signing exceeding its time window withholds the result and stays consumed across restart',async()=>{
        f.onSign=async request=>{const row=await f.db('qz_proto_intencoes').where({request_digest:request}).first();if(row.chamada==='print')f.advance(16000);};
        client=await createFrontendQzHarness({f,identity});await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);
        const row=await f.db('qz_proto_intencoes').where({chamada:'print'}).first();assert.equal(row.estado,'CONSUMIDA');
        await client.close();await f.restart();await f.bootstrap();
        assert.equal((await f.request('/sign',{intentId:row.id,request:row.request_digest})).status,409);assert.equal(f.signCalls,2);
    });
    for(const fault of ['audit','crypto','certificate','signature'])test('complete client path fails closed for '+fault,async()=>{
        if(fault==='audit')await f.failAudit('SIGN_CLAIMED');if(fault==='crypto')f.signFailure=true;
        client=await createFrontendQzHarness({f,identity,presentedCertificate:fault==='certificate'?wrongIdentity.cert:identity.cert,corruptSignature:fault==='signature'});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);
        if(['audit','certificate'].includes(fault))assert.equal(f.signCalls,0);
        assert.equal(client.logs.join('\n').includes('SYNTHETIC_PRIVATE_SECRET'),false);
    });
    test('administrative station revocation between prepare and sign blocks the existing client',async()=>{
        client=await createFrontendQzHarness({f,identity,afterPrepare:async({call})=>{if(call==='print')await f.db('qz_proto_estacoes').where({id:f.station.id}).update({ativo:false});}});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,1);
    });
    test('administrative session revocation after a print intent blocks its use',async()=>{
        client=await createFrontendQzHarness({f,identity,afterPrepare:async({call})=>{
            if(call!=='print')return;const marker=await f.db('infinitepay_identidade_ambiente').where({id:1}).first();
            await f.db('infinitepay_sessoes_revogadas').insert({implantacao_id:marker.identidade,token_hash:digest('infinitepay-admin-session-v1\0'+f.session.token),usuario_id:f.actor.id,revogado_em:f.clock,expira_em:new Date(f.clock.getTime()+3600000)});
        }});
        await assert.rejects(client.print());assert.equal(client.state.acceptedPrints,0);assert.equal(f.signCalls,1);
    });
    test('closing the adapted client cannot replace the shared QZ transport or leave a usable signer',async()=>{
        client=await createFrontendQzHarness({f,identity});assert.equal(client.library.version,'2.2.6');
        assert.notStrictEqual(client.library,syntheticQz);await client.close();
        await assert.rejects(client.print());assert.equal(f.signCalls,0);
    });
});
