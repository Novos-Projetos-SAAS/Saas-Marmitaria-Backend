import {test,describe,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

describe('isolated preproduction integrated rehearsal',{concurrency:false},()=>{
    let lab,f;
    before(async()=>{const {createPreproductionLab}=await import('../helpers/preproductionLab.js');lab=await createPreproductionLab();});
    after(async()=>{await lab?.close();});
    beforeEach(async()=>{f=await lab.fixture();});
    afterEach(async()=>{await f?.close();});

    test('HTTPS administration scopes capabilities, expiry, logout, stop, restart and supervised recovery',async()=>{
        assert.equal((await f.request('/control')).status,403);
        await f.bootstrap();await f.approve(['WORKER','VERIFY_PAYMENT']);await f.enable(['WORKER','VERIFY_PAYMENT']);
        const second=await f.instance();await second.authorizer.approve({session:f.session,capabilities:['WORKER','VERIFY_PAYMENT']});
        assert.equal(await second.authorizer.authorize(f.context('WORKER')),true);
        assert.equal(await f.authorizer.authorize({...f.context('VERIFY_PAYMENT'),deploymentId:randomUUID()}),false);
        f.advance(301000);assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);
        await f.approve(['WORKER','VERIFY_PAYMENT']);
        const logout=await f.request('/admin/logout',{method:'POST',body:{}});assert.equal(logout.status,200);
        assert.ok(logout.headers['set-cookie'][0].includes('token=;'));assert.ok(logout.headers['set-cookie'][0].includes('HttpOnly'));
        assert.equal((await f.request('/control/csrf')).status,403);assert.equal(await second.authorizer.authorize(f.context('WORKER')),false);
        await f.restart();assert.equal((await f.request('/control/csrf')).status,403);
        f.login();await f.bootstrap();await f.approve(['WORKER','VERIFY_PAYMENT']);
        assert.equal((await f.request('/control/emergency-stop',{method:'POST',body:{}})).status,200);
        const generation=(await f.request('/control')).data.data.generation;
        await f.restart();assert.equal((await f.request('/control')).data.data.halted,true);
        assert.equal((await f.request('/control/approvals',{method:'POST',body:{capabilities:['WORKER']}})).status,403);
        assert.equal((await f.request('/control/recovery',{method:'POST',body:{expectedGeneration:generation,confirmation:'RECUPERAR SEM ATIVAR CAPACIDADES'}})).status,200);
        assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);assert.equal(f.service.status().running,false);
        assert.deepEqual(f.provider.counts,{links:0,checks:0});
    });
    for(const method of ['PIX','CARTAO_CREDITO'])test('backend proof, reservation and durable receipt work together for '+method,async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order(method),requestId=randomUUID();
        const results=await Promise.all([f.checkout(order,requestId),f.checkout(order,requestId)]);
        assert.ok(results.some(result=>result.pagamento_status==='AGUARDANDO'));
        assert.ok(results.every(result=>['CRIANDO','AGUARDANDO'].includes(result.pagamento_status)));assert.equal(f.provider.counts.links,1);
        assert.equal((await f.db('pagamentos').where({pedido_id:order.id}).first()).status,'AGUARDANDO');
        assert.equal(Number((await f.db('outbox_eventos').count('* as n').first()).n),0);
        f.provider.paid=false;await f.paidEvent(order);await f.service.runtime.processPending();
        assert.equal((await f.db('pedidos').where({id:order.id}).first()).liberado_cozinha_em,null);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
        f.provider.paid=true;f.advance(60000);await f.service.runtime.processPending();
        assert.equal((await f.db('pagamentos').where({pedido_id:order.id}).first()).status,'PAGA');
        assert.equal(Number((await f.db('outbox_eventos').where({pedido_id:order.id}).count('* as n').first()).n),1);
        assert.equal((await f.db('outbox_eventos').where({pedido_id:order.id}).first()).status,'CONCLUIDO');
        const receipt=await f.receipt(order);assert.equal(receipt.printed,false);assert.equal(receipt.stage,'RECEIVED');
        const second=await f.instance();await second.authorizer.approve({session:f.session,capabilities:f.caps,destinationId:f.destination});
        await second.service.start({intervalMs:60000});
        await Promise.all([f.service.runtime.processPending(),second.service.runtime.processPending()]);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
        assert.equal(f.provider.counts.links,1);
        const wrong=await f.instance({destination:'wrong-station'});
        await wrong.authorizer.approve({session:f.session,capabilities:['WORKER','DELIVER_ORDER'],destinationId:f.destination});
        await assert.rejects(wrong.service.start({intervalMs:60000}));
    });
    test('ambiguous creation survives restart without another dispatch and has no outbox',async()=>{
        await f.bootstrap();await f.approve();await f.enable();f.provider.timeout=true;
        const order=await f.order(),requestId=randomUUID();assert.equal((await f.checkout(order,requestId)).pagamento_status,'INCERTA');
        assert.equal(f.provider.counts.links,1);await f.restart();await f.approve();await f.enable();
        assert.equal((await f.checkout(order,requestId)).pagamento_status,'INCERTA');assert.equal(f.provider.counts.links,1);
        assert.equal(Number((await f.db('outbox_eventos').count('* as n').first()).n),0);
        const health=await f.health();assert.equal(health.financial.uncertain,1);assert.equal(health.commercialReady,false);
    });
    test('lost receipt response recovers the original key after restart, with no physical printing',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order();await f.checkout(order,randomUUID());
        f.receiverMode='timeout_after_receipt';await f.paidEvent(order);await f.service.runtime.processPending();
        assert.equal((await f.db('infinitepay_entregas_operacionais').first()).status,'INCERTA');
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
        const pendingOutbox=await f.db('outbox_eventos').first();
        f.advance(Math.max(301000,new Date(pendingOutbox.criado_em).getTime()-f.clock.getTime()+301000));
        const health=await f.health();assert.equal(health.deliveries.uncertain,1);assert.equal(health.outbox.failed,1);assert.equal(health.outbox.overdue,1);
        await f.restart();await f.approve(['WORKER','DELIVER_ORDER']);await f.enable(['WORKER','DELIVER_ORDER']);
        await f.recoverDelivery(order);f.advance(60000);await f.service.runtime.processPending();
        assert.equal((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal((await f.receipt(order)).printed,false);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
    });
    test('revocation during receipt transit preserves evidence and explicit reprint is a separate synthetic audited effect',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order();await f.checkout(order,randomUUID());
        f.onReceived=async()=>{await f.authorizer.emergencyStop({session:f.session});};
        await f.paidEvent(order);await f.service.runtime.processPending();
        assert.equal((await f.authorizer.status({session:f.session})).halted,true);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
        await assert.rejects(f.reprint(order,{requestId:randomUUID(),confirmation:'SIMULAR REIMPRESSAO'}));
        const generation=(await f.authorizer.status({session:f.session})).generation;
        await f.restart();await f.authorizer.recover({session:f.session,expectedGeneration:generation,confirmation:'RECUPERAR SEM ATIVAR CAPACIDADES'});
        await f.approve(['WORKER','DELIVER_ORDER']);await f.enable(['WORKER','DELIVER_ORDER']);
        await f.recoverDelivery(order);
        await assert.rejects(f.reprint(order,{requestId:randomUUID(),confirmation:'SIMULAR REIMPRESSAO'}));
        await f.grantSyntheticReprint();const input={requestId:randomUUID(),confirmation:'SIMULAR REIMPRESSAO'};
        const [one,two]=await Promise.all([f.reprint(order,input),f.reprint(order,input)]);
        assert.equal(one.id,two.id);assert.equal(one.printed,false);assert.equal(one.simulated,true);
        assert.equal(Number((await f.db('infinitepay_reimpressoes_sinteticas').count('* as n').first()).n),1);
    });
    test('backup restores audit, outbox, revocation and authenticated receipt in another PostgreSQL instance',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order();await f.checkout(order,randomUUID());
        f.receiverMode='timeout_after_receipt';await f.paidEvent(order);await f.service.runtime.processPending();
        await f.authorizer.emergencyStop({session:f.session});await f.authorizer.endSession({session:f.session});
        const restored=await lab.restore(f);
        try {
            assert.ok(restored.backupMetadata.bytes>0);assert.match(restored.backupMetadata.sha256,/^[a-f0-9]{64}$/);
            assert.notEqual(restored.db.client.config.connection.port,f.db.client.config.connection.port);
            for(const table of ['knex_migrations','pedidos','itens_pedido','pagamentos','pagamentos_eventos','outbox_eventos','infinitepay_sessoes_revogadas','infinitepay_paradas_producao',
                'infinitepay_autorizacoes_producao','infinitepay_autorizacao_decisoes','infinitepay_controle_acoes','infinitepay_entregas_operacionais','infinitepay_entregas_tentativas','infinitepay_destino_sintetico']) {
                const rows=async db=>(await db(table)).map(row=>JSON.stringify(row)).sort();assert.deepEqual(await rows(restored.db),await rows(f.db));
            }
            await assert.rejects(restored.authorizer.csrf({session:f.session}));
            await restored.restartDatabase();assert.equal(restored.service.status().running,false);
            restored.login();await restored.bootstrap();assert.equal((await restored.authorizer.status({session:restored.session})).halted,true);
            const generation=(await restored.authorizer.status({session:restored.session})).generation;
            await restored.authorizer.recover({session:restored.session,expectedGeneration:generation,confirmation:'RECUPERAR SEM ATIVAR CAPACIDADES'});
            assert.equal(await restored.authorizer.authorize(restored.context('WORKER')),false);
            await restored.approve(['WORKER','DELIVER_ORDER']);await restored.enable(['WORKER','DELIVER_ORDER']);await restored.recoverDelivery(order);
            restored.advance(60000);await restored.service.runtime.processPending();
            assert.equal((await restored.db('outbox_eventos').first()).status,'CONCLUIDO');
            assert.equal(Number((await restored.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
            assert.deepEqual(restored.provider.counts,{links:0,checks:0});
        }finally{await restored.close();}
    });
    test('diagnostics are sanitized and unavailable storage/audit/credential or divergent identity deny operations',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const initial=await f.health();
        assert.equal(initial.storageAvailable,true);assert.equal(initial.commercialReady,false);
        for(const secret of [f.session.token,f.session.csrf,'SYNTHETIC_PREPROD_KEY',f.env.INFINITEPAY_DATABASE_ID])assert.equal(JSON.stringify(initial).includes(secret),false);
        const workerStatus=f.service.status;f.service.status=()=>({running:true,cycles:undefined,errors:NaN});
        try{assert.equal((await f.request('/diagnostics')).status,503);}finally{f.service.status=workerStatus;}
        const fail=query=>{if(query.sql.includes('outbox_eventos'))throw new Error('SYNTHETIC_SECRET_STORAGE');};
        f.db.on('query',fail);try{const response=await f.request('/diagnostics');assert.equal(response.status,503);assert.equal(JSON.stringify(response.data).includes('SYNTHETIC_SECRET_STORAGE'),false);}
        finally{f.db.removeListener('query',fail);}
        await f.db.raw("CREATE FUNCTION synthetic_reject_rehearsal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC'; END $$");
        await f.db.raw('CREATE TRIGGER synthetic_reject_rehearsal_audit BEFORE INSERT ON infinitepay_autorizacao_decisoes FOR EACH ROW EXECUTE FUNCTION synthetic_reject_rehearsal_audit()');
        assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);
        await f.db.raw('DROP TRIGGER synthetic_reject_rehearsal_audit ON infinitepay_autorizacao_decisoes');
        const before=f.env.INFINITEPAY_DATABASE_ID;f.env.INFINITEPAY_DATABASE_ID=randomUUID();
        assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);f.env.INFINITEPAY_DATABASE_ID=before;
        const old=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=Buffer.alloc(32).toString('base64');
        try{assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);}finally{process.env.INFINITEPAY_ENCRYPTION_KEY=old;}
    });
    test('normal logout remains compatible while sensitive logout requires the new CSRF contract',async()=>{
        const legacy=await f.request('/legacy/logout',{method:'POST'});assert.equal(legacy.status,200);
        assert.equal(legacy.data.status,'success');
        assert.equal((await f.request('/admin/logout',{method:'POST'})).status,403);
        await f.bootstrap();const permission=await f.db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();
        await f.db('permissoes_usuarios').where({usuario_id:f.actor.id,permissao_id:permission.id}).del();
        assert.equal((await f.request('/legacy/logout',{method:'POST'})).status,200);
        assert.equal((await f.request('/admin/logout',{method:'POST'})).status,403);
        await f.db('permissoes_usuarios').insert({usuario_id:f.actor.id,permissao_id:permission.id});
        const bridged=await f.request('/admin/logout',{method:'POST'});assert.equal(bridged.status,200);
        assert.equal(bridged.data.message,legacy.data.message);
    });
    test('a simulated independent check already in transit preserves proof while emergency stop prevents delivery',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order();await f.checkout(order,randomUUID());
        f.provider.onCheck=async()=>{await f.authorizer.emergencyStop({session:f.session});};
        await f.paidEvent(order);await f.service.runtime.processPending();
        assert.equal((await f.db('pagamentos').first()).status,'PAGA');assert.equal((await f.authorizer.status({session:f.session})).halted,true);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
        const before={...f.provider.counts};await f.service.runtime.processPending();assert.deepEqual(f.provider.counts,before);
    });
    test('short approval really expires while bounded shift renewal remains a non-authorizing simulation',async()=>{
        await f.bootstrap();await f.approve(['WORKER','VERIFY_PAYMENT']);assert.equal(await f.authorizer.authorize(f.context('WORKER')),true);
        f.advance(301000);assert.equal(await f.authorizer.authorize(f.context('WORKER')),false);
        const {prepareSupervisedShiftContract,evaluateSupervisedShift}=await import('../../src/services/supervisedShiftContract.js');
        const contract=prepareSupervisedShiftContract({enabled:false,shiftSeconds:3600,maxShiftSeconds:7200,leaseSeconds:300,supervisionSeconds:60});
        const sample={now:301000,shiftStartedAt:0,leaseStartedAt:300000,lastSupervisedAt:300000,humanApprovedLease:true,
            processApproved:true,capabilities:['WORKER','VERIFY_PAYMENT'],operation:'VERIFY_PAYMENT',revoked:false,stopped:false};
        const renewed=evaluateSupervisedShift(contract,sample);assert.equal(renewed.wouldAllow,true);assert.equal(renewed.authorized,false);
        for(const change of [{humanApprovedLease:false},{processApproved:false},{revoked:true},{stopped:true}])
            assert.equal(evaluateSupervisedShift(contract,{...sample,...change}).wouldAllow,false);
    });
    test('synthetic worker failure appears in local metrics and persistent outbox/delivery indicators',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const order=await f.order();await f.checkout(order,randomUUID());
        await f.service.stop();f.receiverMode='before_receipt';await f.paidEvent(order);await f.service.start({intervalMs:60000});
        for(let n=0;n<300 && f.service.status().errors===0;n++)await new Promise(resolve=>setTimeout(resolve,10));
        const health=await f.health();assert.ok(health.worker.errors>0);assert.equal(health.outbox.failed,1);assert.equal(health.deliveries.uncertain,1);
        assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
    });
    test('a stop between administrative observation and the metrics snapshot cannot appear healthy',async()=>{
        await f.bootstrap();await f.approve();await f.enable();const original=f.authorizer.status;let stopped=false;
        f.authorizer.status=async request=>{const state=await original(request);if(!stopped){stopped=true;await f.authorizer.emergencyStop({session:f.session});}return state;};
        try{const response=await f.request('/diagnostics');assert.equal(response.status,503);assert.equal(response.data.code,'DIAGNOSTICS_UNAVAILABLE');}
        finally{f.authorizer.status=original;}
        assert.equal((await f.health()).administration.stopped,true);
    });
    test('restart before delivery leaves a paid outbox blocked until new explicit delivery approval',async()=>{
        await f.bootstrap();await f.approve();await f.enable(['WORKER','CREATE_LINK','VERIFY_PAYMENT']);
        const order=await f.order();await f.checkout(order,randomUUID());await f.paidEvent(order);await f.service.runtime.processPending();
        assert.equal((await f.db('pagamentos').first()).status,'PAGA');assert.equal((await f.db('outbox_eventos').first()).status,'PENDENTE');
        await f.restart();await f.service.runtime.processPending();assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),0);
        const caps=['WORKER','VERIFY_PAYMENT','DELIVER_ORDER'];await f.approve(caps);
        const second=await f.instance();await second.authorizer.approve({session:f.session,capabilities:caps,destinationId:f.destination});
        Object.assign(f.env,{INFINITEPAY_WORKER_ENABLED:'true',INFINITEPAY_VERIFY_ENABLED:'true',INFINITEPAY_DELIVERY_ENABLED:'false'});
        await Promise.all([f.service.start({intervalMs:60000}),second.service.start({intervalMs:60000})]);
        for(let n=0;n<500 && (!f.service.status().cycles || !second.service.status().cycles);n++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(f.service.status().cycles>0 && second.service.status().cycles>0);assert.equal((await f.db('outbox_eventos').first()).status,'PENDENTE');
        Object.assign(f.env,{INFINITEPAY_VERIFY_ENABLED:'false',INFINITEPAY_DELIVERY_ENABLED:'true'});
        await Promise.all([f.service.runtime.processPending(),second.service.runtime.processPending()]);
        assert.equal((await f.db('outbox_eventos').first()).status,'CONCLUIDO');assert.equal(Number((await f.db('infinitepay_destino_sintetico').count('* as n').first()).n),1);
        assert.equal(Number((await f.db('infinitepay_entregas_tentativas').count('* as n').first()).n),1);
    });
});
