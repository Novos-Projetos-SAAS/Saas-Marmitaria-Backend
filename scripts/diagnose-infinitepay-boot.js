import 'dotenv/config';
import {readdir} from 'node:fs/promises';
import knex from 'knex';
import knexConfiguration from '../knexfile.js';
import {validateProductionEnvironment, assertProductionDatabase} from '../src/config/infinitepayProduction.js';

/**
 * A read-only production-profile preflight. It reports fixed diagnostic codes,
 * never exception messages, SQL parameters, configuration values or secrets.
 * No migrations, inserts, updates, worker starts, or payment requests.
 */
const failures = [];
function report(code, ok, description) {
    console[ok ? 'log' : 'error'](`[${ok ? 'OK' : 'FALHA'}] ${code} - ${description}`);
    if(!ok) failures.push(code);
}
let config;
try {
    config=validateProductionEnvironment(process.env);
    report('ENV_VALID',true,'Configuração financeira de produção válida.');
} catch {
    report('ENV_INVALID',false,'Variáveis incompatíveis; execute npm run diagnose:infinitepay:local.');
}
if(!config) process.exit(1);
const connection=knexConfiguration.production?.connection;
const client=knex(knexConfiguration.production);
let connected=false;
try {
    const tls=connection?.ssl && connection.ssl!==true && connection.ssl.rejectUnauthorized===true;
    report('DB_TLS_VERIFIED',Boolean(tls),'Conexão PostgreSQL com verificação TLS ativa.');
    try {
        await client.raw('SELECT 1');
        connected=true;
        report('DB_CONNECTED',true,'Conexão com Neon estabelecida.');
    } catch {
        report('DB_CONNECTED',false,'Conexão PostgreSQL indisponível. Verifique o banco e o TLS.');
    }
    if(connected) {
        let actual;
        try {
            actual=(await client.raw('SELECT current_database() AS name, current_schema() AS schema')).rows[0];
            report('DB_NAME_MATCH',actual?.name===config.database,'Nome do banco conectado corresponde à identidade configurada.');
            report('DB_SCHEMA_SAFE',actual?.schema!=='infinitepay_demo','Schema de demonstração não utilizado.');
        } catch {
            report('DB_METADATA',false,'Metadados do banco inacessíveis.');
        }
        let hasMarker=false;
        try {
            hasMarker=await client.schema.hasTable('infinitepay_identidade_ambiente');
            report('DB_IDENTITY_TABLE',hasMarker,'Tabela de identidade da implantação encontrada.');
        } catch {
            report('DB_IDENTITY_TABLE',false,'Não foi possível consultar a tabela de identidade.');
        }
        if(hasMarker) {
            try {
                const marker=await client('infinitepay_identidade_ambiente').where({id:1}).first('ambiente','identidade');
                report('DB_IDENTITY_ROW',Boolean(marker),'Registro id=1 da identidade financeira encontrado.');
                if(marker) {
                    report('DB_IDENTITY_PRODUCTION',marker.ambiente==='PRODUCAO','Registro autorizado como PRODUCAO.');
                    report('DB_IDENTITY_MATCH',String(marker.identidade).toLowerCase()===config.databaseId,
                        'Identificador registrado coincide com INFINITEPAY_DATABASE_ID.');
                }
            } catch {
                report('DB_IDENTITY_READ',false,'Falha ao consultar a identidade financeira (permissões ou schema).');
            }
        }
        const required=['infinitepay_entregas_operacionais','infinitepay_entregas_tentativas',
            'infinitepay_autorizacoes_producao','infinitepay_controle_producao',
            'infinitepay_autorizacao_decisoes','infinitepay_sessoes_revogadas',
            'config_infinitepay','infinitepay_credenciais'];
        for(const table of required) {
            try {
                report('DB_TABLE_'+table.toUpperCase(),await client.schema.hasTable(table),
                    'Tabela financeira '+table+' disponível.');
            } catch {
                report('DB_TABLE_'+table.toUpperCase(),false,'Não foi possível verificar a tabela financeira '+table+'.');
            }
        }
        try {
            const names=(await readdir(new URL('../src/database/migrations/', import.meta.url))).filter(name=>name.endsWith('.js'));
            const hasMigrations=await client.schema.hasTable('knex_migrations');
            report('DB_KNEX_MIGRATIONS_TABLE',hasMigrations,'Tabela de controle de migrations disponível.');
            if(hasMigrations) {
                const applied=new Set((await client('knex_migrations').select('name')).map(row=>row.name));
                report('DB_MIGRATIONS_CURRENT',names.every(name=>applied.has(name)),
                    'Todas as migrations do repositório constam como aplicadas.');
            }
        } catch {
            report('DB_MIGRATIONS_CHECK',false,'Não foi possível verificar o histórico de migrations.');
        }
        try {
            await assertProductionDatabase(client,config);
            report('DB_PRODUCTION_ASSERT',true,'Validação completa da identidade financeira passou.');
        } catch {
            report('DB_PRODUCTION_ASSERT',false,'Validação financeira do banco falhou; consulte as verificações acima.');
        }
    }
} finally {
    await client.destroy().catch(()=>{});
}
if(failures.length) {
    console.error('Diagnóstico de inicialização: REPROVADO. Códigos: '+failures.join(', '));
    process.exitCode=1;
} else {
    console.log('Diagnóstico de inicialização: APROVADO (somente pré-requisitos de ambiente e banco).');
    console.log('Não autoriza pagamentos nem comprova callback HTTPS, checkout ou permissões administrativas.');
}
