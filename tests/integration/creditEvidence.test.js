import { before,after,test,describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { createCreditControl,H4 } from '../../scripts/credit/control.js';
import { createCreditVerification } from '../../scripts/credit/verification.js';
import { digest,observeCredit,openObservation,sealObservation } from '../../scripts/credit/observations.js';

describe('H4 independent credit evidence and optional receipt', {concurrency:false},()=>{
let fixture,db,key,previousKeys,verification,payment,financialRow,callbackRows,context;
const origin='https://synthetic-evidence.trycloudflare.com',apiKey='SYNTHETIC_H44_KEY',now=()=>new Date('2026-10-27T15:00:00Z');
const observed={success:true,paid:true,amount:100,paid_amount:100,capture_method:'credit_card',installments:1};
const common={phase:'H4_CREDIT',amount_centavos:100,currency:'BRL',method:'credit_card',installments:1,use_limit:1,handle:'matheuszxp',
    database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',
    approved_by:'INTERACTIVE_LOCAL_OPERATOR',public_origin:origin,credential_sha256:digest(apiKey),approved_at:'2026-10-27T14:55:00Z',expires_at:'2026-10-27T15:10:00Z'};
before(async()=>{
    fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();key=randomBytes(32);
    previousKeys=Object.fromEntries(['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(name=>[name,process.env[name]]));
    process.env.INFINITEPAY_ENCRYPTION_KEY=key.toString('base64');process.env.INFINITEPAY_ENCRYPTION_KEYS=JSON.stringify({1:key.toString('base64')});process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION='1';
    const control=createCreditControl({db,captureKey:key,publicOrigin:origin,now});await control.pinOrigin();
    await control.create({apiKey,confirmed:true,authorization:{...common,schema_version:2,operation:'CREATE_LINK',attempt_reference:'70bb57e7-f1f3-498f-a174-0f204c83249f',
        minimum_status:'NOT_CONFIRMED',minimum_basis:'RESEARCH_AND_OPERATOR_EXPERIENCE',minimum_risk_accepted:true,account_binding:'OPERATOR_DECLARED'},
        transport:async()=>new Response(JSON.stringify({url:'https://checkout.infinitepay.io/SYNTHETIC-ONLY'}),{status:200})});
    payment=await db('pagamentos').first();const marker=await db('pagamentos_eventos').where({event_key:H4.command}).first(),request=openObservation(marker.payload_filtrado,key).request;
    const callback={event_type:'paid',order_nsu:payment.order_nsu,transaction_nsu:'SYNTHETIC-TX',invoice_slug:'SYNTHETIC-INVOICE',receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TX'};
    await observeCredit(db,key,'WEBHOOK',{body:JSON.stringify(callback),headers:{}});
    await observeCredit(db,key,'RETURN',{body:JSON.stringify({...callback,slug:callback.invoice_slug,r:new URL(request.redirect_url).searchParams.get('r')}),headers:{}});
    verification=createCreditVerification({db,captureKey:key,publicOrigin:origin,now});context=(await verification.binding()).context;
    await db('pagamentos_eventos').insert({event_key:H4.check,tipo_evento:'H4_RESERVA_PAYMENT_CHECK',pagamento_id:payment.id,status_processamento:'PENDENTE_IDENTIFICACAO'});
    await observeCredit(db,key,'PAYMENT_CHECK',{status:200,body:JSON.stringify(observed),context},payment.id);
    await db('pagamentos').where({id:payment.id}).update({status:'INCERTA'});
    financialRow=await db('pagamentos_eventos').where({tipo_evento:'H4_OBSERVACAO_PAYMENT_CHECK'}).first();
    callbackRows=await db('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_WEBHOOK','H4_OBSERVACAO_RETURN']).orderBy('id');
});
after(async()=>{await fixture?.close();for(const [name,value]of Object.entries(previousKeys??{})){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
const snapshot=async()=>Object.fromEntries(await Promise.all(['pagamentos','pagamentos_eventos','pedidos','outbox_eventos'].map(async table=>[table,await db(table).orderBy('id')])));
test('H4 re-evaluates the exact stored response without receipt_url under read-only isolation and preserves history',async()=>{
    const before=await snapshot(),queries=[],listener=q=>queries.push(q.sql);db.on('query',listener);
    let result;try{result=await verification.result();}finally{db.removeListener('query',listener);}
    assert.equal(result.payment_confirmed,true);assert.equal(result.reconciliation_ready,true);assert.equal(result.receipt_available,true);
    assert.equal(result.amount,100);assert.equal(result.paid_amount,100);assert.deepEqual(result.provider_echo_fields,[]);
    assert.deepEqual(result.evidence_sources.receipt_url,['PERSISTED_RETURN','PERSISTED_WEBHOOK']);
    assert.equal(result.evidence_sources.amount,'PAYMENT_CHECK_HTTP_200');assert.equal(result.callback_signature_verified,false);
    assert.ok(queries.some(sql=>sql.includes('REPEATABLE READ READ ONLY')));assert.ok(queries.every(sql=>/^(select|set|begin|commit)/i.test(sql.trim())));
    assert.deepEqual(await snapshot(),before);assert.equal(openObservation(financialRow.payload_filtrado,key).body,JSON.stringify(observed));
    assert.equal((await db('pagamentos').first()).status,'INCERTA');assert.equal((await db('pedidos').first()).liberado_cozinha_em,null);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC-TX|SYNTHETIC-INVOICE|SYNTHETIC_H44_KEY|https:\/\//);
});
test('H4 rejects incompatible independent proof even when a paid webhook and receipt are present',async()=>{
    const original=openObservation(financialRow.payload_filtrado,key);
    try{
        for(const patch of [{amount:101},{paid:false},{capture_method:'pix'},{installments:2},{transaction_nsu:'OTHER'}]){
            await db('pagamentos_eventos').where({id:financialRow.id}).update({payload_filtrado:sealObservation({...original,body:JSON.stringify({...observed,...patch})},key)});
            assert.equal((await verification.result()).payment_confirmed,false);
        }
        await db('pagamentos_eventos').where({id:financialRow.id}).update({payload_filtrado:sealObservation({...original,status:503},key)});
        assert.equal((await verification.result()).payment_confirmed,false);
        await db('pagamentos_eventos').where({id:financialRow.id}).update({tipo_evento:'H4_SYNTHETIC_NO_INDEPENDENT_PROOF'});
        assert.equal((await verification.result()).reason,'CHECK_NOT_AVAILABLE');
    }finally{await db('pagamentos_eventos').where({id:financialRow.id}).update({tipo_evento:financialRow.tipo_evento,payload_filtrado:financialRow.payload_filtrado});}
});
test('H4 distinguishes absent receipt from an incompatible callback receipt without losing independent payment proof',async()=>{
    try{
        for(const row of callbackRows){const capture=openObservation(row.payload_filtrado,key),raw=JSON.parse(capture.body);delete raw.receipt_url;
            await db('pagamentos_eventos').where({id:row.id}).update({payload_filtrado:sealObservation({...capture,body:JSON.stringify(raw)},key)});}
        const absent=await verification.result();assert.equal(absent.payment_confirmed,true);assert.equal(absent.receipt_available,false);assert.equal(absent.receipt_status,'ABSENT');
        const capture=openObservation(callbackRows[0].payload_filtrado,key),raw=JSON.parse(capture.body);raw.receipt_url='https://recibo.infinitepay.io/OTHER';
        await db('pagamentos_eventos').where({id:callbackRows[0].id}).update({payload_filtrado:sealObservation({...capture,body:JSON.stringify(raw)},key)});
        const blocked=await verification.result();assert.equal(blocked.payment_confirmed,true);assert.equal(blocked.receipt_available,false);assert.equal(blocked.reconciliation_ready,false);
    }finally{for(const row of callbackRows)await db('pagamentos_eventos').where({id:row.id}).update({payload_filtrado:row.payload_filtrado});}
});
test('H4 retains the existing block when nonce or identifiers cannot safely bind proof to the current attempt',async()=>{
    const row=callbackRows.find(item=>item.tipo_evento==='H4_OBSERVACAO_RETURN'),capture=openObservation(row.payload_filtrado,key),raw=JSON.parse(capture.body);
    try{
        for(const patch of [{r:'OTHER_NONCE'},{transaction_nsu:'OTHER_TRANSACTION'},{slug:'OTHER_INVOICE'}]){
            await db('pagamentos_eventos').where({id:row.id}).update({payload_filtrado:sealObservation({...capture,body:JSON.stringify({...raw,...patch})},key)});
            const result=await verification.result();assert.equal(result.payment_confirmed,false);assert.equal(result.reconciliation_ready,false);
        }
    }finally{await db('pagamentos_eventos').where({id:row.id}).update({payload_filtrado:row.payload_filtrado});}
});
test('H4 repeated callback delivery preserves a single receipt association and its authorization fingerprint',async()=>{
    const before=await verification.evidenceFingerprint(),capture=openObservation(callbackRows[0].payload_filtrado,key);
    await observeCredit(db,key,'WEBHOOK',{...capture,headers:{'synthetic-retry':'2'}});
    assert.equal(await verification.evidenceFingerprint(),before);assert.equal((await verification.result()).receipt_available,true);
});
test('H4 synthetic reconciliation uses a separately sourced receipt and preserves the original financial response',async()=>{
    const grant={...common,schema_version:3,operation:'RECONCILE',scope:'EXISTING_H4_ATTEMPT_ONLY',attempt_reference:'70bb57e7-f1f3-498f-a174-0f204c83249f',
        context_sha256:digest(JSON.stringify(context)),proof_sha256:await verification.evidenceFingerprint()};
    await verification.reconcile({authorization:grant,confirmed:true});await verification.reconcile({authorization:grant,confirmed:true});
    const saved=await db('pagamentos').where({id:payment.id}).first();assert.equal(saved.status,'PAGA');assert.equal(saved.receipt_url,'https://recibo.infinitepay.io/SYNTHETIC-TX');
    assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n),1);
    assert.deepEqual(await db('pagamentos_eventos').where({id:financialRow.id}).first(),financialRow);
});
});
