import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { createCreditControl, authorizeCreditOperation } from '../../scripts/credit/control.js';
import { createCreditVerification } from '../../scripts/credit/verification.js';
import { observeCredit, openObservation } from '../../scripts/credit/observations.js';
import { describeExistingPayment } from '../../scripts/credit/followup.js';

let fixture, db, service, key, savedKey;
const origin='https://h4-synthetic.trycloudflare.com', apiKey='SYNTHETIC_H4_KEY_ONLY';
const now=()=>new Date('2026-10-26T15:00:00Z');
function approval(operation='CREATE_LINK', patch={}) {
    return {phase:'H4_CREDIT',operation,amount_centavos:100,method:'credit_card',installments:1,handle:'matheuszxp',
        public_origin:origin,credential_sha256:createHash('sha256').update(apiKey).digest('hex'),
        ...(operation==='CREATE_LINK'?{schema_version:2,currency:'BRL',use_limit:1,database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,
            database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',attempt_reference:'70bb57e7-f1f3-498f-a174-0f204c83249f',minimum_status:'NOT_CONFIRMED',
            minimum_basis:'RESEARCH_AND_OPERATOR_EXPERIENCE',minimum_risk_accepted:true,account_binding:'OPERATOR_DECLARED',approved_by:'INTERACTIVE_LOCAL_OPERATOR'}:
            {minimum_centavos:100,minimum_evidence:'SYNTHETIC_SUPPORT_FIXTURE'}),
        approved_at:'2026-10-26T14:55:00Z',expires_at:'2026-10-26T15:10:00Z',...patch};
}
async function followupApproval(operation,verification) {
    const bound=await verification.binding(),value=approval(operation);delete value.minimum_centavos;delete value.minimum_evidence;
    return {...value,schema_version:3,currency:'BRL',use_limit:1,database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,
        database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',scope:'EXISTING_H4_ATTEMPT_ONLY',approved_by:'INTERACTIVE_LOCAL_OPERATOR',
        attempt_reference:bound.saved.approval.attempt_reference,context_sha256:createHash('sha256').update(JSON.stringify(bound.context)).digest('hex'),
        ...(operation!=='CHECK_PAYMENT'?{proof_sha256:await verification.evidenceFingerprint()}: {})};
}
before(async()=>{
    fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();key=randomBytes(32);
    savedKey=process.env.INFINITEPAY_ENCRYPTION_KEY;process.env.INFINITEPAY_ENCRYPTION_KEY=key.toString('base64');
    service=createCreditControl({db,captureKey:key,publicOrigin:origin,now});await service.pinOrigin();
});
after(async()=>{await fixture?.close();if(savedKey===undefined)delete process.env.INFINITEPAY_ENCRYPTION_KEY;else process.env.INFINITEPAY_ENCRYPTION_KEY=savedKey;});
test('H4 refuses missing/expired authorization, unacknowledged minimum risk, wrong amount/origin/method/credential and noninteractive confirmation', async()=>{
    for(const patch of [{minimum_risk_accepted:false},{minimum_centavos:101},{method:'pix'},{amount_centavos:null},{public_origin:'https://other.trycloudflare.com'},
        {credential_sha256:'0'.repeat(64)},{expires_at:'2026-10-26T14:59:00Z'},{installments:2}]){
        assert.throws(()=>authorizeCreditOperation(approval('CREATE_LINK',patch),'CREATE_LINK',{publicOrigin:origin,apiKey,now:now()}));
    }
    await assert.rejects(service.create({apiKey,authorization:null,confirmed:true,transport:()=>{throw new Error('MUST_NOT_CALL');}}));
    await assert.rejects(service.create({authorization:approval(),confirmed:true,transport:()=>{throw new Error('MUST_NOT_CALL');}}));
    await assert.rejects(service.create({apiKey,authorization:approval(),confirmed:false,transport:()=>{throw new Error('MUST_NOT_CALL');}}));
    assert.equal(Number((await db('pedidos').count('* as n').first()).n),0);
});
test('H4 reserves and dispatches one credit link across concurrency/restart, binds payload and freezes callback origin', async()=>{
    let calls=0;
    const transport=async(url,init)=>{
        calls++;assert.equal(url,'https://api.checkout.infinitepay.io/links');assert.equal(init.headers['X-Api-Key'],apiKey);
        const payload=JSON.parse(init.body);assert.equal(payload.items[0].price,100);assert.match(payload.order_nsu,/^H4-CREDITO-/);
        assert.deepEqual(payload.options.payment_methods_enabled,['credit_card']);assert.equal(payload.options.single_payment,true);
        assert.equal(payload.options.assured_installments,1);assert.equal(payload.options.require_delivery_address,false);assert.equal(payload.options.discounts,undefined);
        return new Response(JSON.stringify({url:'https://checkout.infinitepay.io/SYNTHETIC-H4'}),{status:200});
    };
    const results=await Promise.all(Array.from({length:4},()=>service.create({apiKey,authorization:approval(),confirmed:true,transport})));
    assert.equal(calls,1);assert.ok(results.some(result=>result.attempt_status==='AGUARDANDO'));
    const restarted=createCreditControl({db,captureKey:key,publicOrigin:origin,now});
    await restarted.create({apiKey,authorization:approval(),confirmed:true,transport});assert.equal(calls,1);
    await assert.rejects(createCreditControl({db,captureKey:key,publicOrigin:'https://changed.trycloudflare.com',now}).pinOrigin());
    assert.equal((await restarted.checkout()).url,'https://checkout.infinitepay.io/SYNTHETIC-H4');
    assert.equal(Number((await db('pedidos').count('* as n').first()).n),1);
    assert.equal((await db('pedidos').first()).client_request_id,'70bb57e7-f1f3-498f-a174-0f204c83249f');
    assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n),0);
    assert.equal((await db('pedidos').first()).liberado_cozinha_em,null);
    assert.doesNotMatch(JSON.stringify(await restarted.status()),/SYNTHETIC-H4|SYNTHETIC_H4_KEY_ONLY|order_nsu|transaction_nsu/);
});

test('H4 local status never treats an isolated verification or release timestamp as financial proof',async()=>{
    const marker=await db('pagamentos_eventos').where({event_key:'h4:links:command'}).first(),payment=await db('pagamentos').where({id:marker.pagamento_id}).first();
    try{
        await db('pagamentos').where({id:payment.id}).update({provider_verified_at:now()});
        await db('pedidos').where({id:payment.pedido_id}).update({liberado_cozinha_em:now()});
        const status=await service.status();assert.equal(status.financial_confirmation,false);assert.equal(status.kitchen_released,false);
    }finally{
        await db('pagamentos').where({id:payment.id}).update({provider_verified_at:null});await db('pedidos').where({id:payment.pedido_id}).update({liberado_cozinha_em:null});
    }
});
test('H4 independently checks credit once in observation mode, then reconciles and delivers only with separate permissions',async()=>{
    const marker=await db('pagamentos_eventos').where({event_key:'h4:links:command'}).first(),payment=await db('pagamentos').where({id:marker.pagamento_id}).first();
    const payload=openObservation(marker.payload_filtrado,key).request;
    const event={event_type:'paid',order_nsu:payment.order_nsu,transaction_nsu:'SYNTHETIC-H4-TX',invoice_slug:'SYNTHETIC-H4-INVOICE'};
    await observeCredit(db,key,'WEBHOOK',{body:JSON.stringify(event),headers:{'content-type':'application/json'}});
    await observeCredit(db,key,'RETURN',{body:JSON.stringify({...event,slug:event.invoice_slug,r:new URL(payload.redirect_url).searchParams.get('r')}),headers:{}});
    const verification=createCreditVerification({db,captureKey:key,publicOrigin:origin,now});let calls=0;
    const transport=async(url,init)=>{
        calls++;assert.equal(url,'https://api.checkout.infinitepay.io/payment_check');
        assert.deepEqual(JSON.parse(init.body),{handle:'matheuszxp',order_nsu:payment.order_nsu,transaction_nsu:event.transaction_nsu,slug:event.invoice_slug});
        return new Response(JSON.stringify({success:true,paid:true,amount:100,paid_amount:103,capture_method:'credit_card',installments:1,
            receipt_url:'https://recibo.infinitepay.io/'+event.transaction_nsu}),{status:200});
    };
    await assert.rejects(verification.check({apiKey,authorization:null,confirmed:true,transport}));assert.equal(calls,0);
    const checkApproval=await followupApproval('CHECK_PAYMENT',verification);
    for(const patch of [{context_sha256:'0'.repeat(64)},{attempt_reference:'008c09a8-9ff5-4eb5-bfd9-110cfc7bc54c'}]){
        await assert.rejects(verification.check({apiKey,authorization:{...checkApproval,...patch},confirmed:true,transport}));assert.equal(calls,0);
    }
    const before=JSON.stringify(await db('pagamentos_eventos').orderBy('id'));
    const observed=await describeExistingPayment({db,captureKey:key,publicOrigin:origin,fingerprint:createHash('sha256').update(apiKey).digest('hex'),now});
    assert.equal(observed.report.credential_matches_attempt,true);assert.equal(observed.report.identifiers_consistent,true);
    assert.equal(observed.report.proof_confirmed,false);assert.equal(observed.report.real_check_dispatches,0);
    assert.equal(JSON.stringify(await db('pagamentos_eventos').orderBy('id')),before);
    assert.doesNotMatch(JSON.stringify(observed.report),/SYNTHETIC-H4-TX|SYNTHETIC-H4-INVOICE|SYNTHETIC_H4_KEY_ONLY|receipt_url|order_nsu/);
    const proof=await verification.check({apiKey,authorization:checkApproval,confirmed:true,transport});
    assert.equal(proof.payment_confirmed,true);assert.equal(proof.paid_amount,103);assert.equal(proof.capture_method,'credit_card');
    await Promise.all(Array.from({length:3},()=>verification.check({apiKey,authorization:checkApproval,confirmed:true,transport})));assert.equal(calls,1);
    assert.equal((await db('pagamentos').where({id:payment.id}).first()).status,'AGUARDANDO');
    assert.equal((await db('pedidos').where({id:payment.pedido_id}).first()).liberado_cozinha_em,null);
    await assert.rejects(verification.reconcile({authorization:null,confirmed:true}));
    const reconcileApproval=await followupApproval('RECONCILE',verification);
    await assert.rejects(verification.reconcile({authorization:checkApproval,confirmed:true}));
    await assert.rejects(verification.reconcile({authorization:{...reconcileApproval,proof_sha256:'0'.repeat(64)},confirmed:true}));
    await verification.reconcile({authorization:reconcileApproval,confirmed:true});
    await verification.reconcile({authorization:reconcileApproval,confirmed:true});
    assert.equal((await db('pagamentos').where({id:payment.id}).first()).status,'PAGA');
    const report=await db('vw_rel_pedidos_financeiros').where({id:payment.pedido_id}).first();
    assert.equal(report.venda_considerada,true);assert.equal(Number(report.valor_venda),1);assert.equal(Number(report.valor_pago_provider_centavos),103);
    assert.equal(Number((await db('outbox_eventos').where({pedido_id:payment.pedido_id}).count('* as n').first()).n),1);
    const deliveryApproval=await followupApproval('DELIVER',verification);
    await assert.rejects(verification.deliver({authorization:reconcileApproval,confirmed:true}));
    await verification.deliver({authorization:deliveryApproval,confirmed:true});await verification.deliver({authorization:deliveryApproval,confirmed:true});
    assert.equal(Number((await db('infinitepay_entregas_homologacao').where({pedido_id:payment.pedido_id}).count('* as n').first()).n),1);
    assert.equal(calls,1);
});

test('H4 independently verified evidence stays bound to the planned authorization attempt',async()=>{
    const order=await db('pedidos').first();
    const verification=createCreditVerification({db,captureKey:key,publicOrigin:origin,now});
    await verification.binding();
    try{
        await db('pedidos').where({id:order.id}).update({client_request_id:'008c09a8-9ff5-4eb5-bfd9-110cfc7bc54c'});
        await assert.rejects(verification.binding());
    }finally{await db('pedidos').where({id:order.id}).update({client_request_id:order.client_request_id});}
});
for(const scenario of ['timeout','http-error','invalid-url','key-echo'])test('H4 preserves a single uncertain reservation after '+scenario,async()=>{
    const f=await createTestDatabase();
    try{
        await f.db.migrate.latest();const control=createCreditControl({db:f.db,captureKey:key,publicOrigin:origin,now,timeoutMs:100});await control.pinOrigin();let calls=0;
        const transport=async()=>{calls++;if(scenario==='timeout')return new Promise(()=>{});
            return new Response(JSON.stringify({url:scenario==='invalid-url'?'https://evil.invalid/SYNTHETIC':
                'https://checkout.infinitepay.io/'+(scenario==='key-echo'?encodeURIComponent(apiKey):'SYNTHETIC')}),{status:scenario==='http-error'?503:200});};
        const result=await control.create({apiKey,authorization:approval(),confirmed:true,transport});assert.equal(result.attempt_status,'INCERTA');
        await control.create({apiKey,authorization:approval(),confirmed:true,transport});assert.equal(calls,1);
        if(scenario!=='timeout'&&scenario!=='http-error')await assert.rejects(control.checkout());
        const values=JSON.stringify(await f.db('pagamentos_eventos'));
        assert.equal(values.includes(apiKey),false);assert.equal(values.includes('https://checkout.infinitepay.io/'),false);
        assert.equal((await f.db('pedidos').first()).liberado_cozinha_em,null);
    }finally{await f.close();}
});
for(const scenario of ['network-failure','timeout','paid-false'])test('H4 preserves the consumed check budget and never releases after '+scenario,async()=>{
    const f=await createTestDatabase();
    try{
        await f.db.migrate.latest();const control=createCreditControl({db:f.db,captureKey:key,publicOrigin:origin,now});await control.pinOrigin();
        await control.create({apiKey,authorization:approval(),confirmed:true,transport:async()=>new Response(JSON.stringify({url:'https://checkout.infinitepay.io/SYNTHETIC-ONLY'}),{status:200})});
        const payment=await f.db('pagamentos').first();
        await observeCredit(f.db,key,'WEBHOOK',{body:JSON.stringify({event_type:'paid',order_nsu:payment.order_nsu,transaction_nsu:'SYNTHETIC-TX',invoice_slug:'SYNTHETIC-INVOICE'}),headers:{}});
        const verification=createCreditVerification({db:f.db,captureKey:key,publicOrigin:origin,now}),grant=await followupApproval('CHECK_PAYMENT',verification);let calls=0;
        const transport=async()=>{calls++;if(scenario!=='paid-false')throw Object.assign(new Error('SYNTHETIC_PROVIDER_FAILURE'),{name:scenario==='timeout'?'TimeoutError':'Error'});
            return new Response(JSON.stringify({success:true,paid:false,amount:100,paid_amount:0,capture_method:'credit_card',installments:1}),{status:200});};
        assert.equal((await verification.check({apiKey,authorization:grant,confirmed:true,transport})).payment_confirmed,false);
        const restarted=createCreditVerification({db:f.db,captureKey:key,publicOrigin:origin,now});
        await restarted.check({apiKey,authorization:grant,confirmed:true,transport});assert.equal(calls,1);
        assert.equal((await control.status()).real_link_dispatches,1);assert.equal((await control.status()).real_check_dispatches,1);
        assert.equal((await control.status()).attempt_status,'INCERTA');assert.equal((await control.status()).kitchen_released,false);
        assert.equal(Number((await f.db('outbox_eventos').count('* as n').first()).n),0);
    }finally{await f.close();}
});
