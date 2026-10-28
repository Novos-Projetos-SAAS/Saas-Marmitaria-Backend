import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFollowupApproval, readPrivateApproval } from '../../scripts/credit/authorization.js';
import { authorizeCreditOperation } from '../../scripts/credit/control.js';

const now=()=>new Date('2026-10-27T15:00:00Z'),origin='https://synthetic-followup.trycloudflare.com';
const inspection={publicOrigin:origin,binding:{attempt_reference:'70bb57e7-f1f3-498f-a174-0f204c83249f',context_sha256:'a'.repeat(64),
    credential_sha256:'b'.repeat(64),handle:'matheuszxp',amount_centavos:100},
    report:{reserved:true,amount_centavos:100,attempt_status:'AGUARDANDO',real_link_dispatches:1,real_check_dispatches:0,
        checkout_enabled:false,credential_matches_attempt:true,identifiers_consistent:true,origin_preserved:true,proof_confirmed:false,outbox_count:0}};
async function fixture(run){const directory=await mkdtemp(join(tmpdir(),'h4-followup-synthetic-'));try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}
const options=(directory,operation='CHECK_PAYMENT',view=inspection)=>({directory,operation,amount:100,inspect:async()=>view,confirm:async()=>true,now});
test('H4 missing private approval identifies the specific registration action without reusing CREATE_LINK',async()=>fixture(async directory=>{
    await assert.rejects(readPrivateApproval(directory,'CHECK_PAYMENT'),error=>error.code==='H4_APPROVAL_MISSING' && error.registrationAction==='AuthorizeCheckPayment');
}));
test('H4 check approval requires a human decision and binds only the existing attempt, identifiers and credential',async()=>fixture(async directory=>{
    await assert.rejects(registerFollowupApproval({...options(directory),confirm:async()=>false}));assert.deepEqual(await readdir(directory),[]);
    const result=await registerFollowupApproval(options(directory));assert.equal(result.financial_requests,0);
    const approval=await readPrivateApproval(directory,'CHECK_PAYMENT');
    assert.equal(approval.context_sha256,'a'.repeat(64));assert.equal(approval.attempt_reference,inspection.binding.attempt_reference);
    assert.equal(approval.schema_version,3);assert.equal(approval.currency,'BRL');assert.equal(approval.use_limit,1);
    assert.equal(approval.minimum_evidence,undefined);assert.equal(approval.minimum_centavos,undefined);
    assert.doesNotThrow(()=>authorizeCreditOperation(approval,'CHECK_PAYMENT',{publicOrigin:origin,now:now()}));
    assert.throws(()=>authorizeCreditOperation(approval,'CREATE_LINK',{publicOrigin:origin,now:now()}));
    for(const patch of [{context_sha256:''},{database:'production'},{amount_centavos:500},{use_limit:2},{operation:'DELIVER'},{expires_at:'2026-10-27T16:00:00Z'}])
        assert.throws(()=>authorizeCreditOperation({...approval,...patch},'CHECK_PAYMENT',{publicOrigin:origin,now:now()}));
    const before=await readFile(join(directory,'approval-CHECK_PAYMENT.json'),'utf8');
    await assert.rejects(registerFollowupApproval(options(directory)));assert.equal(await readFile(join(directory,'approval-CHECK_PAYMENT.json'),'utf8'),before);
}));
test('H4 does not register check approval after a consumed query budget or changed binding',async()=>fixture(async directory=>{
    await assert.rejects(registerFollowupApproval(options(directory,'CHECK_PAYMENT',{...inspection,report:{...inspection.report,real_check_dispatches:1}})));
    let calls=0;
    await assert.rejects(registerFollowupApproval({...options(directory),inspect:async()=>++calls===1?inspection:{...inspection,binding:{...inspection.binding,context_sha256:'c'.repeat(64)}}}));
    assert.deepEqual(await readdir(directory),[]);
}));
test('H4 reconciles and delivers only under distinct grants after independent proof and the corresponding stage',async()=>fixture(async directory=>{
    await assert.rejects(registerFollowupApproval(options(directory,'RECONCILE')));
    const proven={...inspection,binding:{...inspection.binding,proof_sha256:'d'.repeat(64)},report:{...inspection.report,real_check_dispatches:1,proof_confirmed:true,reconciliation_ready:true}};
    await assert.rejects(registerFollowupApproval({...options(directory,'RECONCILE',{...proven,report:{...proven.report,reconciliation_ready:false}}),confirm:()=>{throw new Error('MUST_NOT_PROMPT');}}));
    await registerFollowupApproval(options(directory,'RECONCILE',proven));
    const approval=await readPrivateApproval(directory,'RECONCILE');assert.equal(approval.proof_sha256,'d'.repeat(64));
    await assert.rejects(registerFollowupApproval(options(directory,'DELIVER',proven)));
    await registerFollowupApproval(options(directory,'DELIVER',{...proven,report:{...proven.report,attempt_status:'PAGA',outbox_count:1}}));
    assert.deepEqual((await readdir(directory)).sort(),['approval-DELIVER.json','approval-RECONCILE.json']);
}));
