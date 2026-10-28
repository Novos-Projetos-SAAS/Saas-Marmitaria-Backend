import knex from 'knex';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCreditProfile, privateDirectory } from './environment.js';
import { readCreditDatabase } from './diagnose.js';
import { createCreditVerification } from './verification.js';
import { H4, authorizeCreditOperation } from './control.js';
import { digest, openObservation } from './observations.js';
import { readPrivateApproval, registrationActions, registerFollowupApproval } from './authorization.js';
import { confirmFollowupAuthorization } from './terminal.js';
import { aplicarElegibilidadeOperacional } from '../../src/utils/pedidoPaymentPolicy.js';

export async function describeExistingPayment({db,captureKey,publicOrigin,fingerprint,now=()=>new Date()}) {
    return db.transaction(async trx=>{
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const verification=createCreditVerification({db,captureKey,publicOrigin,now}),bound=await verification.binding(trx);
        const proof=await verification.result(trx),count=async query=>Number((await query.count('* as n').first()).n);
        const eligible=Boolean(await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id',bound.payment.pedido_id).first('pedidos.id'));
        const observations=await trx('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_WEBHOOK','H4_OBSERVACAO_RETURN']);
        let webhooks=0,returns=0,paid=0;
        for(const row of observations){
            const observed=openObservation(row.payload_filtrado,captureKey);let payload;
            try{payload=JSON.parse(observed.body);}catch{continue;}
            if(payload.order_nsu!==bound.expected.orderNsu)continue;
            if(row.tipo_evento==='H4_OBSERVACAO_RETURN')returns++;
            else{webhooks++;if(payload.event_type==='paid')paid++;}
        }
        return {publicOrigin,binding:{attempt_reference:bound.saved.approval.attempt_reference,context_sha256:digest(JSON.stringify(bound.context)),
            credential_sha256:digest(bound.apiKey),handle:bound.payment.handle_snapshot,amount_centavos:Number(bound.payment.valor_centavos),
            ...(proof.reconciliation_ready?{proof_sha256:await verification.evidenceFingerprint(trx)}:{})},
            report:{reserved:true,amount_centavos:Number(bound.payment.valor_centavos),attempt_status:bound.payment.status,
                real_link_dispatches:await count(trx('pagamentos_eventos').where({event_key:H4.dispatch})),
                real_check_dispatches:await count(trx('pagamentos_eventos').where({event_key:H4.check})),
                checkout_enabled:(await trx('config_infinitepay').where({id:1}).first('ativo')).ativo,
                credential_matches_attempt:digest(bound.apiKey)===fingerprint,identifiers_consistent:true,origin_preserved:true,
                proof_confirmed:proof.payment_confirmed,reconciliation_ready:proof.reconciliation_ready,check_result:proof,outbox_count:await count(trx('outbox_eventos').where({pedido_id:bound.payment.pedido_id,tipo:'PEDIDO_LIBERADO'})),
                financial_confirmation:Boolean(eligible && bound.payment.capture_method==='credit_card' && ['PAGA','LIQUIDADA'].includes(bound.payment.status)),
                kitchen_released:eligible,events:{matched_webhooks:webhooks,matched_returns:returns,webhook_paid:paid,
                    pending_paid:await count(trx('pagamentos_eventos').where({tipo_evento:'paid',status_processamento:'PENDENTE'}).whereRaw("payload_filtrado->>'orderNsu'=?",[bound.expected.orderNsu]))}}};
    });
}

async function inspectPayment() {
    if(process.env.NODE_ENV!=='development' || process.env.INFINITEPAY_CHECKOUT_ENABLED!=='false' || process.env.CREDIT_DPAPI_STATUS!=='VALID')throw new Error();
    const profile=await loadCreditProfile(),endpoints=JSON.parse(await readFile(join(privateDirectory,'endpoints.json'),'utf8'));
    process.env.INFINITEPAY_ENCRYPTION_KEY=profile.encryptionKey;delete process.env.INFINITEPAY_ENCRYPTION_KEYS;process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION='1';
    const db=knex({client:'pg',connection:{host:profile.host,port:profile.port,database:profile.database,user:profile.user,ssl:false,connectionTimeoutMillis:5000,
        options:'-c search_path=public -c default_transaction_read_only=on',application_name:'infinitepay-credit-existing-attempt'},pool:{min:0,max:1},acquireConnectionTimeout:7000});
    try{
        const expectedMigrations=(await readdir(new URL('../../src/database/migrations/',import.meta.url))).filter(name=>name.endsWith('.js'));
        const base=await readCreditDatabase({db,profile,expectedMigrations,publicOrigin:endpoints.origin});
        if(!base.identity || !base.migrations || !base.disabled || !base.pinned || !base.intended_account_compatible || base.real_link_dispatches!==1 || base.non_probe_attempts!==1)throw new Error();
        return await describeExistingPayment({db,captureKey:Buffer.from(profile.encryptionKey,'base64'),publicOrigin:endpoints.origin,fingerprint:process.env.CREDIT_CREDENTIAL_SHA256});
    }finally{await db.destroy();}
}

async function diagnosePayment() {
    const inspection=await inspectPayment(),authorizations=[];
    for(const operation of ['CHECK_PAYMENT','RECONCILE','DELIVER']){
        try{
            const approval=await readPrivateApproval(privateDirectory,operation);
            authorizeCreditOperation(approval,operation,{publicOrigin:inspection.publicOrigin});
            if(approval.credential_sha256!==inspection.binding.credential_sha256 || approval.context_sha256!==inspection.binding.context_sha256 ||
                approval.attempt_reference!==inspection.binding.attempt_reference || (operation!=='CHECK_PAYMENT' && approval.proof_sha256!==inspection.binding.proof_sha256))throw new Error();
            authorizations.push({operation,status:'APROVADO',registration_action:registrationActions[operation]});
        }catch(error){authorizations.push({operation,status:error.code==='H4_APPROVAL_MISSING'?'AGUARDANDO AUTORIZAÇÃO':'BLOQUEADO',
            reason:error.code==='H4_APPROVAL_MISSING'?'AUTHORIZATION_FILE_MISSING':'AUTHORIZATION_INVALID_OR_BINDING_CHANGED',registration_action:registrationActions[operation]});}
    }
    console.log(JSON.stringify({...inspection.report,authorizations,financial_requests:0,new_checkout:false},null,2));
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{
        const operation=process.argv[2];
        if(operation==='diagnose')await diagnosePayment();
        else{
            if(!process.stdin.isTTY || !process.stdout.isTTY)throw new Error();
            console.log(JSON.stringify(await registerFollowupApproval({directory:privateDirectory,operation,amount:Number(process.env.CREDIT_AMOUNT_CENTAVOS),
                inspect:inspectPayment,confirm:confirmFollowupAuthorization}),null,2));
        }
    }catch{console.error('Operação sobre tentativa existente bloqueada. Preserve a origem e as evidências; nenhum envio financeiro executado.');process.exitCode=1;}
}
