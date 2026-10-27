import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseCredit } from '../../scripts/credit/diagnose.js';
import { digest } from '../../scripts/credit/observations.js';

const origin='https://synthetic-h41.trycloudflare.com', now=new Date('2026-10-27T01:00:00Z');
const profile={purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',host:'127.0.0.1',port:55439,database:'infinitepay_credit_homologacao',user:'codex_test',checkoutEnabled:false,encryptionKey:Buffer.alloc(32,1).toString('base64')};
const database={identity:true,migrations:true,disabled:true,one_installment:true,intended_account_compatible:true,pinned:true,reserved:false,attempt_status:null,
    real_link_dispatches:0,real_check_dispatches:0,financial_confirmation:false,kitchen_released:false,
    non_probe_attempts:0,provider_observations:0,attempts_by_status:[{status:'FALHOU',total:1}],callback_events:3};
const authorization={phase:'H4_CREDIT',operation:'CREATE_LINK',method:'credit_card',installments:1,handle:'matheuszxp',amount_centavos:100,
    schema_version:2,currency:'BRL',use_limit:1,database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,
    database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',attempt_reference:'70bb57e7-f1f3-498f-a174-0f204c83249f',minimum_status:'NOT_CONFIRMED',
    minimum_basis:'RESEARCH_AND_OPERATOR_EXPERIENCE',minimum_risk_accepted:true,account_binding:'OPERATOR_DECLARED',approved_by:'INTERACTIVE_LOCAL_OPERATOR',
    public_origin:origin,credential_sha256:digest('SYNTHETIC_KEY'),approved_at:'2026-10-27T00:55:00Z',expires_at:'2026-10-27T01:10:00Z'};
function options(patch={}) {
    return {profile,endpoints:{origin},database,credential:{status:'VALID',fingerprint:digest('SYNTHETIC_KEY')},
        processes:{backend:'VALID',tunnel:'VALID'},runtime:{nodeEnv:'development',checkoutEnabled:'false'},approval:{state:'MISSING'},now,
        transport:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.headers,undefined);
            assert.equal(new URL(url).origin,origin);assert.equal(new URL(url).search,'');
            return new Response('',{status:url.endsWith('/webhook')?405:url.endsWith('/retorno')?400:200});},...patch};
}
const state=(result,id)=>result.checks.find(check=>check.id===id)?.status;

test('H4 diagnosis distinguishes missing authorization from valid local infrastructure without exposing secrets',async()=>{
    const result=await diagnoseCredit(options());
    assert.equal(state(result,'credential'),'APROVADO');assert.equal(state(result,'database'),'APROVADO');
    assert.equal(state(result,'https'),'APROVADO');assert.equal(state(result,'authorization'),'AGUARDANDO AUTORIZAÇÃO');
    assert.equal(state(result,'minimum'),'NÃO VERIFICADO');assert.equal(result.first_creation_gate,'AUTHORIZATION_FILE_MISSING');
    assert.equal(result.financial_operation_performed,false);assert.equal(result.ready_to_create,false);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_KEY|SYNTHETIC_SUPPORT_ONLY|credential_sha256|encryptionKey|SYNTHETIC-H4-TX/);
});
test('H4 diagnosis never contacts even callback URLs for an invalid profile',async()=>{
    const result=await diagnoseCredit(options({profile:{...profile,database:'production'},transport:()=>{throw new Error('MUST_NOT_CALL');}}));
    assert.equal(state(result,'profile'),'BLOQUEADO');assert.equal(state(result,'https'),'NÃO VERIFICADO');
});
for(const [name,patch,id] of [
    ['missing credential',{credential:{status:'MISSING'}},'credential'],
    ['corrupt credential',{credential:{status:'INVALID'}},'credential'],
    ['wrong database',{database:{...database,identity:false}},'database'],
    ['missing migration',{database:{...database,migrations:false}},'migrations'],
    ['enabled checkout',{database:{...database,disabled:false}},'activation'],
    ['incompatible fee absorption configuration',{database:{...database,one_installment:false}},'installments_config'],
    ['conflicting local account',{database:{...database,intended_account_compatible:false}},'account_context'],
    ['invalid HTTPS',{endpoints:{origin:'http://synthetic-h41.trycloudflare.com'}},'origin'],
    ['unrecognized tunnel',{processes:{backend:'VALID',tunnel:'INVALID'}},'tunnel'],
    ['reserved attempt',{database:{...database,reserved:true,attempt_status:'INCERTA',real_link_dispatches:1,non_probe_attempts:1}},'reservation'],
    ['unmarked financial attempt',{database:{...database,non_probe_attempts:1}},'reservation'],
    ['provider evidence without marker',{database:{...database,provider_observations:1}},'reservation'],
]) test('H4 diagnosis blocks '+name,async()=>{
    const result=await diagnoseCredit(options(patch));assert.equal(state(result,id),'BLOQUEADO');assert.equal(result.ready_to_create,false);
});
test('H4 diagnosis validates a synthetic authorization but never authorizes dispatch or interactive confirmation',async()=>{
    const result=await diagnoseCredit(options({approval:{state:'PRESENT',value:authorization}}));
    assert.equal(state(result,'authorization'),'APROVADO');assert.equal(state(result,'minimum'),'NÃO VERIFICADO');
    assert.equal(state(result,'minimum_risk'),'APROVADO');
    assert.equal(state(result,'credential_binding'),'APROVADO');assert.equal(state(result,'interactive'),'AGUARDANDO AUTORIZAÇÃO');
    assert.equal(result.ready_to_create,false);assert.equal(result.financial_operation_performed,false);
});
for(const patch of [{expires_at:'2026-10-27T00:00:00Z'},{minimum_risk_accepted:false},{credential_sha256:'0'.repeat(64)}])
    test('H4 diagnosis refuses an expired, incomplete or mismatched synthetic authorization '+Object.keys(patch)[0],async()=>{
        const result=await diagnoseCredit(options({approval:{state:'PRESENT',value:{...authorization,...patch}}}));
        assert.ok(['BLOQUEADO'].includes(state(result,'authorization')) || state(result,'credential_binding')==='BLOQUEADO');
        assert.equal(result.ready_to_create,false);
    });
test('H4 diagnosis reports callback failure without treating prior successful callbacks as live HTTPS',async()=>{
    const result=await diagnoseCredit(options({transport:async()=>{throw new Error('PRIVATE_URL_OR_TOKEN');}}));
    assert.equal(state(result,'https'),'BLOQUEADO');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_URL_OR_TOKEN/);
});
