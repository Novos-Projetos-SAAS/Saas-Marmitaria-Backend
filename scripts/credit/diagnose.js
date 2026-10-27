import knex from 'knex';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCreditProfile, validateCreditProfile, privateDirectory } from './environment.js';
import { creditOrigin, authorizeCreditOperation, H4 } from './control.js';
import { aplicarElegibilidadeOperacional } from '../../src/utils/pedidoPaymentPolicy.js';

const OK='APROVADO', BLOCKED='BLOQUEADO', WAIT='AGUARDANDO AUTORIZAÇÃO', UNKNOWN='NÃO VERIFICADO';

// No raw payloads, credentials, checkout URLs or financial identifiers leave this reader.
export async function readCreditDatabase({db,profile,expectedMigrations,publicOrigin}) {
    return db.transaction(async trx=>{
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const identity=(await trx.raw('SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port')).rows[0];
        if(identity.name!==profile.database || identity.host!==profile.host || identity.port!==profile.port)return {identity:false};
        if((await trx('credit_identity').first('purpose'))?.purpose!==profile.purpose)return {identity:false};
        const migrations=(await trx('knex_migrations').select('name')).map(row=>row.name).sort();
        if(JSON.stringify(migrations)!==JSON.stringify([...expectedMigrations].sort()))return {identity:true,migrations:false};
        const config=await trx('config_infinitepay').where({id:1}).first('ativo','assured_installments');
        const origin=await trx('pagamentos_eventos').where({event_key:H4.origin}).first('payload_filtrado');
        const command=await trx('pagamentos_eventos').where({event_key:H4.command}).first('pagamento_id');
        const payment=command?.pagamento_id && await trx('pagamentos').where({id:command.pagamento_id}).first('status','pedido_id','capture_method');
        const verifiedRelease=payment && Boolean(await aplicarElegibilidadeOperacional(trx('pedidos')).where('pedidos.id',payment.pedido_id).whereNull('pedidos.deletado_em').first('pedidos.id'));
        const count=async query=>Number((await query.count('* as n').first()).n);
        // Only the explicitly linked failed preflight fixture is excluded from financial attempts.
        const probeIds=trx('pagamentos_eventos').where({tipo_evento:'H4_PRETESTE'}).whereNotNull('pagamento_id').select('pagamento_id');
        const suspicious=trx('pagamentos').where(builder=>builder.whereNotIn('id',probeIds)
            .orWhereNot('status','FALHOU').orWhere('bloqueia_nova_cobranca',true)
            .orWhereNotNull('checkout_url').orWhereNotNull('transaction_nsu').orWhereNotNull('invoice_slug').orWhereNotNull('provider_verified_at'));
        return {identity:true,migrations:true,disabled:config?.ativo===false,one_installment:config?.assured_installments===1,
            pinned:origin?.payload_filtrado?.origin===publicOrigin,reserved:Boolean(command),attempt_status:payment?.status??null,
            real_link_dispatches:await count(trx('pagamentos_eventos').where({event_key:H4.dispatch})),
            real_check_dispatches:await count(trx('pagamentos_eventos').where({event_key:H4.check})),
            provider_observations:await count(trx('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_LINKS','H4_OBSERVACAO_PAYMENT_CHECK'])),
            non_probe_attempts:await count(suspicious),
            financial_confirmation:Boolean(verifiedRelease && payment.capture_method==='credit_card' && ['PAGA','LIQUIDADA'].includes(payment.status)),
            kitchen_released:(await count(aplicarElegibilidadeOperacional(trx('pedidos'))))>0,
            attempts_by_status:(await trx('pagamentos').select('status').count('* as total').groupBy('status')).map(row=>({status:row.status,total:Number(row.total)})),
            callback_events:await count(trx('pagamentos_eventos').whereIn('tipo_evento',['H4_OBSERVACAO_WEBHOOK','H4_OBSERVACAO_RETURN']))};
    });
}

export async function diagnoseCredit({profile,database,endpoints,credential={},processes={},runtime={},approval={},transport=globalThis.fetch,now=new Date()}) {
    const checks=[],add=(id,status,detail)=>checks.push({id,status,detail});
    let validProfile=false,validOrigin=false,validApproval=false;
    try{validateCreditProfile(profile);validProfile=true;}catch{}
    add('profile',validProfile?OK:BLOCKED,'Perfil exclusivo H4, loopback:55439 e banco infinitepay_credit_homologacao.');
    add('runtime',runtime.nodeEnv==='development' && runtime.checkoutEnabled==='false'?OK:BLOCKED,'NODE_ENV=development; checkout desligado no processo de diagnóstico.');
    add('credential',credential.status==='VALID'?OK:credential.status==='MISSING'||credential.status==='INVALID'?BLOCKED:UNKNOWN,
        credential.status==='VALID'?'DPAPI presente e decifrável pelo operador; chave não exibida nem enviada.':credential.status==='MISSING'?'Arquivo DPAPI ausente.':'Integridade DPAPI não confirmada.');
    add('credential_provider',UNKNOWN,'Conta/permissões da chave não consultadas na InfinitePay nesta leitura.');
    try{creditOrigin(endpoints?.origin);validOrigin=true;}catch{}
    add('origin',validOrigin?OK:BLOCKED,'Origem HTTPS exclusiva descoberta do Quick Tunnel; nenhum checkout privado é exibido.');
    for(const id of ['tunnel','backend'])add(id,processes[id]==='VALID'?OK:BLOCKED,'Identidade local exige PID, início, executável, comando e porta de loopback corretos.');
    const identity=validProfile && database?.identity===true, migrated=identity && database?.migrations===true;
    add('database',!validProfile?UNKNOWN:identity?OK:BLOCKED,'Identidade consultada no PostgreSQL, finalidade H4 e transação somente leitura.');
    add('migrations',!identity?UNKNOWN:migrated?OK:BLOCKED,'Comparação exata das migrations aplicadas com os arquivos atuais; nenhuma migration executada.');
    add('activation',!migrated?UNKNOWN:database.disabled===true?OK:BLOCKED,'config_infinitepay.ativo deve permanecer false. Nenhum worker é iniciado por Diagnose.');
    add('installments_config',!migrated?UNKNOWN:database.one_installment===true?OK:BLOCKED,'A criação H4 exige assured_installments=1 para absorção de taxas; isso não limita o comprador a 1x.');
    add('pinned_origin',!migrated || !validOrigin?UNKNOWN:database.pinned===true?OK:BLOCKED,'Origem efetiva deve corresponder à origem persistida; Diagnose não a altera.');
    const clean=migrated && database.reserved===false && database.non_probe_attempts===0 && database.provider_observations===0 &&
        database.real_link_dispatches===0 && database.real_check_dispatches===0 && database.financial_confirmation===false && database.kitchen_released===false;
    add('reservation',!migrated?UNKNOWN:clean?OK:BLOCKED,clean?'Nenhuma reserva, envio ou evidência financeira H4; fixtures de pré-teste identificados separadamente.':'Havendo reserva, envio ou evidência ambígua: preservar registros e conciliar, sem criar outro link.');
    add('callbacks_history',!migrated?UNKNOWN:database.callback_events>0?OK:UNKNOWN,'Contagem local de observações duráveis; não substitui pré-teste de persistência e deduplicação.');
    let https=UNKNOWN;
    if(validProfile && validOrigin && identity && processes.backend==='VALID' && processes.tunnel==='VALID'){
        try{
            for(const [path,status] of [['/pedido/sucesso',200],['/pagamentos/infinitepay/webhook',405],['/pagamentos/infinitepay/retorno',400]]){
                const response=await transport(endpoints.origin+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000)});
                await response.body?.cancel();if(response.status!==status)throw new Error();
            }
            https=OK;
        }catch{https=BLOCKED;}
    }
    add('https',https,'Somente GET sem parâmetros: TLS válido, sucesso200, webhook405 e retorno400. Nenhum evento é enviado ou persistido.');
    let firstCreationGate=!validProfile?'PROFILE_INVALID':!identity?'DATABASE_UNVERIFIED':!migrated?'MIGRATIONS_MISMATCH':!database.disabled?'CHECKOUT_ENABLED':!validOrigin?'HTTPS_ORIGIN_INVALID':null;
    if(approval.state==='MISSING'){
        add('authorization',WAIT,'approval-CREATE_LINK.json ausente; CreateLink para antes da credencial, da reserva e do POST.');
        firstCreationGate??='AUTHORIZATION_FILE_MISSING';
    }else{
        try{if(!validOrigin || approval.state!=='PRESENT')throw new Error();authorizeCreditOperation(approval.value,'CREATE_LINK',{publicOrigin:endpoints.origin,now});validApproval=true;}catch{}
        add('authorization',validApproval?OK:BLOCKED,validApproval?'Autorização local válida em estrutura e prazo; não executada.':'Autorização ausente, ilegível, inválida ou vencida; não será criada pelo diagnóstico.');
        if(!validApproval)firstCreationGate??='AUTHORIZATION_INVALID';
    }
    const minimum=Number.isSafeInteger(approval.value?.minimum_centavos) && approval.value.minimum_centavos>0 &&
        approval.value.minimum_centavos<=approval.value.amount_centavos && typeof approval.value.minimum_evidence==='string' && Boolean(approval.value.minimum_evidence.trim());
    add('minimum',minimum?OK:UNKNOWN,minimum?'Evidência aplicável registrada na autorização; origem oficial deve ser conferida pelo responsável.':'Mínimo de Crédito ainda sem evidência aplicável; exemplos de preços não são regra de mínimo.');
    add('credential_binding',!validApproval || credential.status!=='VALID'?UNKNOWN:approval.value.credential_sha256===credential.fingerprint?OK:BLOCKED,'Vínculo local entre fingerprint da credencial e autorização, sem expor o hash ou a chave.');
    add('interactive',WAIT,'A confirmação exata da operação só será solicitada em futura criação autorizada; Diagnose não a solicita.');
    const technicalIds=['profile','runtime','credential','origin','tunnel','backend','database','migrations','activation','installments_config','pinned_origin','reservation','callbacks_history','https'];
    const technicalReady=technicalIds.every(id=>checks.find(check=>check.id===id)?.status===OK);
    return {checks,first_creation_gate:firstCreationGate,technical_ready:technicalReady,ready_to_create:false,
        financial_operation_performed:false,automatic_retry:false,
        state:migrated?{reserved:database.reserved,attempt_status:database.attempt_status,real_link_dispatches:database.real_link_dispatches,
            real_check_dispatches:database.real_check_dispatches,provider_observations:database.provider_observations,
            other_financial_attempts:database.non_probe_attempts,financial_confirmation:database.financial_confirmation,
            kitchen_released:database.kitchen_released,checkout_enabled:!database.disabled,attempts_by_status:database.attempts_by_status}:null,
        summary:technicalReady && minimum?'PRONTO TECNICAMENTE — AGUARDANDO AUTORIZAÇÃO FINANCEIRA DO OPERADOR.':
            'CRIAÇÃO BLOQUEADA — conferir os requisitos pendentes; nenhuma operação financeira executada.'};
}

async function runDiagnosis() {
    let profile,endpoints,approval,database,db;
    try{profile=await loadCreditProfile();}catch{}
    try{endpoints=JSON.parse(await readFile(join(privateDirectory,'endpoints.json'),'utf8'));}catch{}
    try{approval={state:'PRESENT',value:JSON.parse((await readFile(join(privateDirectory,'approval-CREATE_LINK.json'),'utf8')).replace(/^\uFEFF/,''))};}
    catch(error){approval={state:error.code==='ENOENT'?'MISSING':'INVALID'};}
    try{
        if(profile){
            db=knex({client:'pg',connection:{host:profile.host,port:profile.port,database:profile.database,user:profile.user,ssl:false,connectionTimeoutMillis:5000,
                options:'-c search_path=public -c default_transaction_read_only=on',application_name:'infinitepay-credit-diagnosis'},pool:{min:0,max:1},acquireConnectionTimeout:7000});
            const expectedMigrations=(await readdir(new URL('../../src/database/migrations/',import.meta.url))).filter(name=>name.endsWith('.js'));
            database=await readCreditDatabase({db,profile,expectedMigrations,publicOrigin:endpoints?.origin});
        }
    }catch{database??={identity:false};}finally{await db?.destroy();}
    const credential={status:process.env.CREDIT_DPAPI_STATUS,fingerprint:process.env.CREDIT_CREDENTIAL_SHA256};
    delete process.env.CREDIT_CREDENTIAL_SHA256;
    const result=await diagnoseCredit({profile,database,endpoints,approval,credential,
        processes:{backend:process.env.CREDIT_BACKEND_STATUS,tunnel:process.env.CREDIT_TUNNEL_STATUS},
        runtime:{nodeEnv:process.env.NODE_ENV,checkoutEnabled:process.env.INFINITEPAY_CHECKOUT_ENABLED}});
    console.log(JSON.stringify(result,null,2));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{await runDiagnosis();}catch{console.error('Diagnóstico indisponível; nenhum envio financeiro é permitido.');process.exitCode=1;}
}
