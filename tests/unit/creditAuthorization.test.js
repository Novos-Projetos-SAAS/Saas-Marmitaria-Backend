import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCreationApproval } from '../../scripts/credit/authorization.js';
import { authorizeCreditOperation } from '../../scripts/credit/control.js';

const origin='https://synthetic-authorization.trycloudflare.com', instant=new Date('2026-10-27T02:00:00Z'), fingerprint='a'.repeat(64);
const inspection=()=>({publicOrigin:origin,diagnosis:{technical_ready:true,first_creation_gate:'AUTHORIZATION_FILE_MISSING',state:{reserved:false,
    real_link_dispatches:0,real_check_dispatches:0,provider_observations:0,other_financial_attempts:0,financial_confirmation:false,kitchen_released:false,checkout_enabled:false}}});
async function fixture(run){const directory=await mkdtemp(join(tmpdir(),'h4-authorization-synthetic-'));try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}
const options=directory=>({directory,amount:100,fingerprint,inspect:async()=>inspection(),confirm:async()=>true,now:()=>instant});

test('H4 authorization registration requires a human decision and leaves no file after cancellation',async()=>fixture(async directory=>{
    await assert.rejects(registerCreationApproval({...options(directory),confirm:async()=>false}));
    assert.deepEqual(await readdir(directory),[]);
}));
test('H4 authorization records a 15-minute single-use BRL scope without claiming a certified minimum',async()=>fixture(async directory=>{
    const result=await registerCreationApproval(options(directory));
    assert.equal(result.financial_requests,0);assert.equal(result.amount_centavos,100);
    const approval=JSON.parse(await readFile(join(directory,'approval-CREATE_LINK.json'),'utf8'));
    assert.equal(approval.currency,'BRL');assert.equal(approval.use_limit,1);assert.equal(approval.database,'infinitepay_credit_homologacao');
    assert.equal(approval.handle,'matheuszxp');assert.equal(approval.public_origin,origin);assert.equal(approval.credential_sha256,fingerprint);
    assert.match(approval.attempt_reference,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    assert.equal(Date.parse(approval.expires_at)-Date.parse(approval.approved_at),900000);
    assert.equal(approval.minimum_status,'NOT_CONFIRMED');assert.equal(approval.minimum_risk_accepted,true);
    assert.equal(approval.minimum_centavos,undefined);assert.equal(approval.minimum_evidence,undefined);
    assert.equal(approval.account_binding,'OPERATOR_DECLARED');
    assert.doesNotThrow(()=>authorizeCreditOperation(approval,'CREATE_LINK',{publicOrigin:origin,now:instant}));
    assert.doesNotMatch(JSON.stringify(result),/credential_sha256|attempt_reference|minimum_evidence/);
    const before=await readFile(join(directory,'approval-CREATE_LINK.json'),'utf8');
    await assert.rejects(registerCreationApproval({...options(directory),confirm:()=>{throw new Error('MUST_NOT_PROMPT_AGAIN');}}));
    assert.equal(await readFile(join(directory,'approval-CREATE_LINK.json'),'utf8'),before);
    for(const patch of [{schema_version:undefined},{currency:'USD'},{amount_centavos:500},{database:'production'},{use_limit:2},{attempt_reference:''},
        {minimum_risk_accepted:false},{minimum_status:'CONFIRMED'},{minimum_evidence:'FABRICATED'},{account_binding:'PROVIDER_VERIFIED'},
        {expires_at:'2026-10-27T03:00:00Z'},{handle:'other_account'}]){
        assert.throws(()=>authorizeCreditOperation({...approval,...patch},'CREATE_LINK',{publicOrigin:origin,now:instant}));
    }
}));
test('H4 authorization refuses an unsafe or changed environment and an invalid fingerprint without writing',async()=>fixture(async directory=>{
    for(const patch of [{amount:500},{fingerprint:''},{inspect:async()=>({publicOrigin:origin,diagnosis:{technical_ready:false}})},
        {inspect:async()=>({...inspection(),publicOrigin:'http://invalid.test'})}]){
        await assert.rejects(registerCreationApproval({...options(directory),...patch}));
    }
    let calls=0;
    await assert.rejects(registerCreationApproval({...options(directory),inspect:async()=>{
        calls++;return calls===1?inspection():{...inspection(),publicOrigin:'https://changed.trycloudflare.com'};
    }}));
    assert.deepEqual(await readdir(directory),[]);
}));
test('concurrent H4 authorization registrations cannot overwrite each other',async()=>fixture(async directory=>{
    const results=await Promise.allSettled([registerCreationApproval(options(directory)),registerCreationApproval(options(directory))]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.deepEqual(await readdir(directory),['approval-CREATE_LINK.json']);
}));
