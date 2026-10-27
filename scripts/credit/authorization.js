import { randomUUID } from 'node:crypto';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';

const refuse=()=>new Error('Autorização H4 não registrada: confira escopo, confirmação e ambiente. Nenhum envio financeiro.');
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
    try{await access(file);throw refuse();}catch(error){if(error.code!=='ENOENT')throw refuse();}
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
    const handle=await open(file,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(approval,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
    return {authorization_registered:true,amount_centavos:100,currency:'BRL',expires_at:approval.expires_at,financial_requests:0,
        minimum_confirmed:false,account_verified_by_provider:false};
}
