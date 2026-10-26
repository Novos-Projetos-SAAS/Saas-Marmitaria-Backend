import knex from 'knex';
import { fileURLToPath } from 'node:url';
import { loadCreditProfile } from './environment.js';
import { initializeInfinitepayApplication } from '../../src/infinitepayApplication.js';
import { createCreditApp } from './app.js';

const profile=await loadCreditProfile();
const db=knex({client:'pg',connection:{host:profile.host,port:profile.port,database:profile.database,user:profile.user,ssl:false,
    options:'-c search_path=public',application_name:'infinitepay-credit-preparation'},pool:{min:0,max:4},
    migrations:{directory:fileURLToPath(new URL('../../src/database/migrations/',import.meta.url))}});
let server;
try {
    const identity=(await db.raw('SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port')).rows[0];
    if(identity.name!==profile.database || identity.host!==profile.host || identity.port!==profile.port)throw new Error();
    const action=process.argv[2];
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
    if(action==='serve') {
        const publicOrigin=process.env.CREDIT_PUBLIC_ORIGIN;
        const env={NODE_ENV:'development',INFINITEPAY_MODE:'homologation',INFINITEPAY_CHECKOUT_ENABLED:'false',
            DB_HOST:profile.host,DB_PORT:String(profile.port),DB_NAME:profile.database,INFINITEPAY_DATABASE_NAME:profile.database,
            INFINITEPAY_PUBLIC_ORIGIN:publicOrigin,INFINITEPAY_SUCCESS_URL:publicOrigin+'/pedido/sucesso',
            INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:publicOrigin,ALLOWED_ORIGINS:publicOrigin};
        process.env.INFINITEPAY_ENCRYPTION_KEY=profile.encryptionKey;
        // No credential is loaded and neither financial HTTP nor worker is enabled in preparation.
        const holder={locals:{}};
        const financial=await initializeInfinitepayApplication({app:holder,db,env,transport:async()=>{throw new Error('Transporte financeiro bloqueado.');}});
        const app=createCreditApp({runtime:financial.runtime,publicOrigin});
        server=app.listen(55447,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
        console.log('Callbacks de Crédito em 127.0.0.1:55447. Checkout e worker desligados; nenhuma API Key carregada.');
        const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await financial.stop();await db.destroy();};
        process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
    } else if(['prepare','status'].includes(action)) {
        console.log(JSON.stringify({database:identity.name,port:identity.port,migrations:Number((await db('knex_migrations').count('* as n').first()).n),
            checkout_enabled:false,worker:false,orders:Number((await db('pedidos').count('* as n').first()).n),attempts:Number((await db('pagamentos').count('* as n').first()).n)}));
    } else throw new Error();
} catch {console.error('Crédito indisponível: confira perfil, identidade do banco, migrations e HTTPS exclusivo. Nenhuma operação financeira autorizada.');process.exitCode=1;}
finally {if(!server?.listening)await db.destroy();}
