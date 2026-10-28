import { randomUUID, createHash } from 'node:crypto';
import { access, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const refuse=()=>new Error('Autorização H4 não registrada: confira escopo, confirmação e ambiente. Nenhum envio financeiro.');
export const registrationActions={CREATE_LINK:'AuthorizeCreateLink',CHECK_PAYMENT:'AuthorizeCheckPayment',RECONCILE:'AuthorizeReconcile',DELIVER:'AuthorizeDeliver'};
export async function readPrivateApproval(directory,operation) {
    if(!Object.hasOwn(registrationActions,operation))throw refuse();
    try{return JSON.parse((await readFile(join(directory,'approval-'+operation+'.json'),'utf8')).replace(/^\uFEFF/,''));}
    catch(error){if(error.code==='ENOENT')throw Object.assign(refuse(),{code:'H4_APPROVAL_MISSING',registrationAction:registrationActions[operation]});throw refuse();}
}
export function validateFollowupScope(approval,now=new Date()) {
    const duration=Date.parse(approval?.expires_at)-Date.parse(approval?.approved_at);
    if(approval?.schema_version!==3 || !['CHECK_PAYMENT','RECONCILE','DELIVER'].includes(approval.operation) || approval.currency!=='BRL' ||
        approval.amount_centavos!==100 || approval.use_limit!==1 || approval.database!=='infinitepay_credit_homologacao' ||
        approval.database_host!=='127.0.0.1' || approval.database_port!==55439 || approval.database_purpose!=='INFINITEPAY_CREDIT_PREPARATION_ONLY' ||
        approval.handle!=='matheuszxp' || approval.scope!=='EXISTING_H4_ATTEMPT_ONLY' || approval.approved_by!=='INTERACTIVE_LOCAL_OPERATOR' ||
        approval.minimum_centavos!==undefined || approval.minimum_evidence!==undefined ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(approval.attempt_reference||'') ||
        !/^[a-f0-9]{64}$/.test(approval.context_sha256||'') ||
        (approval.operation==='CHECK_PAYMENT'?approval.proof_sha256!==undefined:!/^[a-f0-9]{64}$/.test(approval.proof_sha256||'')) ||
        !Number.isFinite(duration) || duration<=0 || duration>900000 || Date.parse(approval.approved_at)>now.getTime() || Date.parse(approval.expires_at)<=now.getTime())throw refuse();
}
export function assertFollowupBinding(approval,bound,proofFingerprint) {
    const hash=value=>createHash('sha256').update(value).digest('hex');
    if(approval.attempt_reference!==bound.saved.approval.attempt_reference || approval.context_sha256!==hash(JSON.stringify(bound.context)) ||
        approval.credential_sha256!==hash(bound.apiKey) || (approval.operation!=='CHECK_PAYMENT' && approval.proof_sha256!==proofFingerprint))throw refuse();
}

async function absent(file) {
    try{await access(file);throw refuse();}catch(error){if(error.code!=='ENOENT')throw refuse();}
}
async function persistApproval(file,approval) {
    const handle=await open(file,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(approval,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
}
export function validateCreationScope(approval,now=new Date()) {
    const duration=Date.parse(approval?.expires_at)-Date.parse(approval?.approved_at);
    if(approval?.schema_version!==2 || approval.currency!=='BRL' || approval.amount_centavos!==100 || approval.use_limit!==1 ||
        approval.database!=='infinitepay_credit_homologacao' || approval.database_host!=='127.0.0.1' || approval.database_port!==55439 ||
        approval.database_purpose!=='INFINITEPAY_CREDIT_PREPARATION_ONLY' || approval.handle!=='matheuszxp' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(approval.attempt_reference||'') ||
        approval.minimum_status!=='NOT_CONFIRMED' || approval.minimum_basis!=='RESEARCH_AND_OPERATOR_EXPERIENCE' ||
        approval.minimum_risk_accepted!==true || approval.minimum_centavos!==undefined || approval.minimum_evidence!==undefined ||
        approval.account_binding!=='OPERATOR_DECLARED' || approval.approved_by!=='INTERACTIVE_LOCAL_OPERATOR' ||
        !Number.isFinite(duration) || duration<=0 || duration>900000 || Date.parse(approval.approved_at)>now.getTime() || Date.parse(approval.expires_at)<=now.getTime())throw refuse();
}

function ready(inspection) {
    const state=inspection?.diagnosis?.state;
    if(inspection?.diagnosis?.technical_ready!==true || inspection.diagnosis.first_creation_gate!=='AUTHORIZATION_FILE_MISSING' ||
        !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(inspection.publicOrigin||'') ||
        state?.reserved!==false || state.real_link_dispatches!==0 || state.real_check_dispatches!==0 || state.provider_observations!==0 ||
        state.other_financial_attempts!==0 || state.financial_confirmation!==false || state.kitchen_released!==false || state.checkout_enabled!==false)throw refuse();
}

// Registration writes only the private approval file. It never reserves a payment or receives financial transport.
export async function registerCreationApproval({directory,amount,fingerprint,inspect,confirm,now=()=>new Date()}) {
    if(amount!==100 || !/^[a-f0-9]{64}$/.test(fingerprint||'') || typeof confirm!=='function')throw refuse();
    const file=join(directory,'approval-CREATE_LINK.json');
    await absent(file);
    const before=await inspect();ready(before);const started=now().getTime();
    if(await confirm({publicOrigin:before.publicOrigin})!==true || now().getTime()-started>300000)throw refuse();
    const after=await inspect();ready(after);
    if(after.publicOrigin!==before.publicOrigin)throw refuse();
    const instant=now(),approval={schema_version:2,phase:'H4_CREDIT',operation:'CREATE_LINK',amount_centavos:100,currency:'BRL',
        method:'credit_card',installments:1,use_limit:1,database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,
        database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',handle:'matheuszxp',credential_sha256:fingerprint,public_origin:after.publicOrigin,
        attempt_reference:randomUUID(),minimum_status:'NOT_CONFIRMED',minimum_basis:'RESEARCH_AND_OPERATOR_EXPERIENCE',minimum_risk_accepted:true,
        account_binding:'OPERATOR_DECLARED',approved_by:'INTERACTIVE_LOCAL_OPERATOR',approved_at:instant.toISOString(),expires_at:new Date(instant.getTime()+900000).toISOString()};
    validateCreationScope(approval,instant);
    // Exclusive creation preserves an existing/partial file after cancellation, a race or a crash. No automatic replacement.
    await persistApproval(file,approval);
    return {authorization_registered:true,amount_centavos:100,currency:'BRL',expires_at:approval.expires_at,financial_requests:0,
        minimum_confirmed:false,account_verified_by_provider:false};
}

function followupReady(inspection,operation) {
    const report=inspection?.report,binding=inspection?.binding;
    if(!binding || report?.reserved!==true || report.amount_centavos!==100 || report.real_link_dispatches!==1 || report.checkout_enabled!==false ||
        report.credential_matches_attempt!==true || report.identifiers_consistent!==true || report.origin_preserved!==true ||
        binding.handle!=='matheuszxp' || binding.amount_centavos!==100 || !/^[a-f0-9]{64}$/.test(binding.credential_sha256||'') ||
        !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(inspection.publicOrigin||''))throw refuse();
    if(operation==='CHECK_PAYMENT'){
        if(report.real_check_dispatches!==0 || !['AGUARDANDO','INCERTA'].includes(report.attempt_status) || report.proof_confirmed!==false || report.outbox_count!==0)throw refuse();
    }else if(report.real_check_dispatches!==1 || report.proof_confirmed!==true || report.reconciliation_ready!==true ||
        (operation==='RECONCILE'?(!['AGUARDANDO','INCERTA'].includes(report.attempt_status) || report.outbox_count!==0):
            (!['PAGA','LIQUIDADA'].includes(report.attempt_status) || report.outbox_count!==1)))throw refuse();
}
export async function registerFollowupApproval({directory,operation,amount,inspect,confirm,now=()=>new Date()}) {
    if(!['CHECK_PAYMENT','RECONCILE','DELIVER'].includes(operation) || amount!==100 || typeof confirm!=='function')throw refuse();
    const file=join(directory,'approval-'+operation+'.json');await absent(file);
    const before=await inspect();followupReady(before,operation);const started=now().getTime();
    if(await confirm({operation,publicOrigin:before.publicOrigin})!==true || now().getTime()-started>300000)throw refuse();
    const after=await inspect();followupReady(after,operation);
    if(before.publicOrigin!==after.publicOrigin || JSON.stringify(before.binding)!==JSON.stringify(after.binding))throw refuse();
    const instant=now(),approval={schema_version:3,phase:'H4_CREDIT',operation,amount_centavos:100,currency:'BRL',method:'credit_card',installments:1,
        use_limit:1,database:'infinitepay_credit_homologacao',database_host:'127.0.0.1',database_port:55439,database_purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',
        scope:'EXISTING_H4_ATTEMPT_ONLY',approved_by:'INTERACTIVE_LOCAL_OPERATOR',public_origin:after.publicOrigin,
        attempt_reference:after.binding.attempt_reference,context_sha256:after.binding.context_sha256,credential_sha256:after.binding.credential_sha256,
        handle:after.binding.handle,...(operation!=='CHECK_PAYMENT'?{proof_sha256:after.binding.proof_sha256}:{}),
        approved_at:instant.toISOString(),expires_at:new Date(instant.getTime()+900000).toISOString()};
    if(operation==='CHECK_PAYMENT')delete approval.proof_sha256;
    validateFollowupScope(approval,instant);await persistApproval(file,approval);
    return {authorization_registered:true,operation,amount_centavos:100,currency:'BRL',expires_at:approval.expires_at,financial_requests:0};
}
