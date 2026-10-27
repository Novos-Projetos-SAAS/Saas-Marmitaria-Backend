import knex from 'knex';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCreditProfile, privateDirectory } from './environment.js';
import { initializeInfinitepayApplication } from '../../src/infinitepayApplication.js';
import { createCreditApp } from './app.js';
import { createH1ProxyVerifier } from '../../src/homologation/infinitepayH1Proxy.js';
import { createCreditControl, authorizeCreditOperation, H4 } from './control.js';
import { createCreditVerification } from './verification.js';
import { observeCredit, observationHeaders, digest } from './observations.js';
import { verifyCreditEndpoints } from './preflight.js';
import { confirmCreditOperation } from './terminal.js';
import { readPrivateApproval } from './authorization.js';

const profile=await loadCreditProfile();
const action=process.argv[2],operation={create:'CREATE_LINK',check:'CHECK_PAYMENT',reconcile:'RECONCILE',deliver:'DELIVER'}[action];
const apiKey=['create','check'].includes(action)?process.env.CREDIT_API_KEY:undefined;delete process.env.CREDIT_API_KEY;
if(process.env.NODE_ENV!=='development' || process.env.INFINITEPAY_CHECKOUT_ENABLED!=='false')throw new Error('Perfil H4 recusado.');
process.env.INFINITEPAY_ENCRYPTION_KEY=profile.encryptionKey;delete process.env.INFINITEPAY_ENCRYPTION_KEYS;process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION='1';
const db=knex({client:'pg',connection:{host:profile.host,port:profile.port,database:profile.database,user:profile.user,ssl:false,
    options:'-c search_path=public'+(['status','events','checkout','evidence','check-result','can-reconfigure'].includes(action)?' -c default_transaction_read_only=on':''),application_name:'infinitepay-credit-preparation'},pool:{min:0,max:4},
    migrations:{directory:fileURLToPath(new URL('../../src/database/migrations/',import.meta.url))}});
let server;
try {
    const identity=(await db.raw('SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port')).rows[0];
    if(identity.name!==profile.database || identity.host!==profile.host || identity.port!==profile.port)throw new Error();
    if(action==='prepare') {
        await db.transaction(async trx=>{
            await trx.raw('SELECT pg_advisory_xact_lock(55439,55447)');
            if(!await trx.schema.hasTable('credit_identity')) {
                const tables=await trx('information_schema.tables').where({table_schema:'public',table_type:'BASE TABLE'});
                if(tables.length)throw new Error();
                await trx.schema.createTable('credit_identity',table=>{table.integer('id').primary();table.text('purpose').notNullable();});
                await trx('credit_identity').insert({id:1,purpose:profile.purpose});
            }
            if((await trx('credit_identity').first())?.purpose!==profile.purpose)throw new Error();
        });
        await db.migrate.latest();
    }
    if((await db('credit_identity').first())?.purpose!==profile.purpose || (await db('config_infinitepay').first())?.ativo!==false)throw new Error();
    const expected=(await readdir(new URL('../../src/database/migrations/',import.meta.url))).filter(name=>name.endsWith('.js')).sort();
    if(JSON.stringify((await db('knex_migrations').select('name')).map(row=>row.name).sort())!==JSON.stringify(expected))throw new Error();
    let endpoints;
    try{endpoints=JSON.parse(await readFile(join(privateDirectory,'endpoints.json'),'utf8'));}catch{}
    const publicOrigin=endpoints?.origin;
    const captureKey=Buffer.from(profile.encryptionKey,'base64');
    const control=publicOrigin && createCreditControl({db,captureKey,publicOrigin});
    const loadApproval=()=>readPrivateApproval(privateDirectory,operation);
    if(operation){
        if(!control)throw new Error();
        const approval=authorizeCreditOperation(await loadApproval(),operation,{publicOrigin,...(process.argv.includes('--gate-only')?{}:{apiKey:operation==='CREATE_LINK'||operation==='CHECK_PAYMENT'?apiKey:undefined})});
        if(Number(process.env.CREDIT_AMOUNT_CENTAVOS)!==approval.amount_centavos)throw new Error();
        await control.pinned();
        if(process.argv.includes('--gate-only')){console.log('Autorização específica encontrada; operação ainda não executada.');}
        else if(operation==='CREATE_LINK' && (await control.status()).reserved){console.log(JSON.stringify(await control.status(),null,2));}
        else {
            if(!process.stdin.isTTY || !process.stdout.isTTY)throw new Error();
            if(operation==='CREATE_LINK')await verifyCreditEndpoints({db,captureKey,publicOrigin});
            const checkedAt=Date.now(),fingerprint=digest(JSON.stringify(approval));
            const confirmed=await confirmCreditOperation({operation,amount:approval.amount_centavos,publicOrigin});
            if(!confirmed || Date.now()-checkedAt>300000 || digest(JSON.stringify(await loadApproval()))!==fingerprint)throw new Error();
            authorizeCreditOperation(approval,operation,{publicOrigin});await control.pinned();
            if(operation==='CREATE_LINK')await verifyCreditEndpoints({db,captureKey,publicOrigin});
            const verification=createCreditVerification({db,captureKey,publicOrigin});
            const options={apiKey,authorization:approval,confirmed:true,transport:globalThis.fetch};
            const result=operation==='CREATE_LINK'?await control.create(options):operation==='CHECK_PAYMENT'?await verification.check(options):
                operation==='RECONCILE'?await verification.reconcile(options):await verification.deliver(options);
            console.log(JSON.stringify(result,null,2));
        }
    }else if(action==='can-reconfigure'){
        if(await db('pagamentos_eventos').whereIn('event_key',[H4.command,H4.dispatch]).first())throw new Error();
        console.log('Reconfiguração permitida somente antes da primeira reserva H4.');
    }else if(action==='preflight'){
        if(!control)throw new Error();console.log(JSON.stringify(await verifyCreditEndpoints({db,captureKey,publicOrigin}),null,2));
    }else if(action==='checkout'){
        if(!process.stdout.isTTY || !control)throw new Error();const proof=await control.checkout();console.log('Checkout já existente; nenhuma nova cobrança. Pagamento somente manual.');process.stdout.write(proof.url+'\n');
    }else if(action==='check-result'){
        console.log(JSON.stringify(await createCreditVerification({db,captureKey,publicOrigin}).result(),null,2));
    }else if(action==='evidence'){
        const evidence=await createCreditVerification({db,captureKey,publicOrigin}).binding();
        console.log(JSON.stringify({identifiers_consistent:true,amount_centavos:evidence.context.amount,expected_method:'credit_card',
            correlation_fingerprint:digest(JSON.stringify(evidence.context)).slice(0,16),financial_confirmation:false}));
    }else if(action==='events'){
        console.log(JSON.stringify(await db('pagamentos_eventos').select('tipo_evento','status_processamento').count('* as total').groupBy('tipo_evento','status_processamento'),null,2));
    }else if(action==='serve') {
        if(!control || endpoints.executable!==join(privateDirectory,'cloudflared.exe'))throw new Error();await control.pinOrigin();
        const env={NODE_ENV:'development',INFINITEPAY_MODE:'homologation',INFINITEPAY_CHECKOUT_ENABLED:'false',
            DB_HOST:profile.host,DB_PORT:String(profile.port),DB_NAME:profile.database,INFINITEPAY_DATABASE_NAME:profile.database,
            INFINITEPAY_PUBLIC_ORIGIN:publicOrigin,INFINITEPAY_SUCCESS_URL:publicOrigin+'/pedido/sucesso',
            INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:publicOrigin,ALLOWED_ORIGINS:publicOrigin};
        // No credential is loaded and neither financial HTTP nor worker is enabled in preparation.
        const holder={locals:{}};
        const financial=await initializeInfinitepayApplication({app:holder,db,env,transport:async()=>{throw new Error('Transporte financeiro bloqueado.');}});
        const verifyProxy=createH1ProxyVerifier({tunnelPid:endpoints.pid,executablePath:endpoints.executable,localPort:55447});
        const app=createCreditApp({runtime:financial.runtime,publicOrigin,verifyProxy,
            observe:(kind,value)=>observeCredit(db,captureKey,kind,{...value,headers:observationHeaders(value.headers)})});
        server=app.listen(55447,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
        console.log('Callbacks de Crédito em 127.0.0.1:55447. Checkout e worker desligados; nenhuma API Key carregada.');
        const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await financial.stop();await db.destroy();};
        process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
    } else if(['prepare','status'].includes(action)) {
        console.log(JSON.stringify({database:identity.name,port:identity.port,migrations:Number((await db('knex_migrations').count('* as n').first()).n),
            checkout_enabled:false,worker:false,orders:Number((await db('pedidos').count('* as n').first()).n),attempts:Number((await db('pagamentos').count('* as n').first()).n),
            synthetic_preflight_attempts:Number((await db('pagamentos_eventos').where({tipo_evento:'H4_PRETESTE'}).count('* as n').first()).n),
            public_origin:publicOrigin??null,...(control?await control.status():{})}));
    } else throw new Error();
} catch(error) {
    console.error(error.code==='H4_APPROVAL_MISSING'?operation+': autorização privada ausente. Registro interativo separado: '+error.registrationAction+'. Nenhuma operação executada.':
        'Crédito indisponível: confira perfil, identidade do banco, migrations e HTTPS exclusivo. Nenhuma operação financeira autorizada.');process.exitCode=1;
}
finally {if(!server?.listening)await db.destroy();}
