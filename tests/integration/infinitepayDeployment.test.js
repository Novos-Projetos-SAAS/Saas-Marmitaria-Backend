import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createTestDatabase, historicalOrder, testConnection } from '../helpers/testDatabase.js';
import { encryptApiKey, decryptApiKey } from '../../src/utils/infinitepayCredentials.js';

const run = promisify(execFile);
const pgBin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';

test('synthetic PostgreSQL backup restores orders, encrypted credentials, attempts, events and constraints', async () => {
    const source = await createTestDatabase(), target = await createTestDatabase();
    const temp = await realpath(tmpdir()), directory = await mkdtemp(join(temp, 'infinitepay-restore-'));
    const names = ['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: randomBytes(32).toString('base64') });
        process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
        await source.db.migrate.latest(); await historicalOrder(source.db);
        const [credential] = await source.db('infinitepay_credenciais').insert({ handle:'restore-synthetic',
            ...encryptApiKey('SYNTHETIC_RESTORE_KEY','restore-synthetic') }).returning('*');
        const [payment] = await source.db('pagamentos').insert({ pedido_id:1,tentativa_numero:1,order_nsu:'SYNTHETIC-RESTORE',
            status:'INCERTA',valor_centavos:2000,valid_until:'2050-01-01T00:00:00Z',credencial_id:credential.id,handle_snapshot:credential.handle }).returning('*');
        await source.db('pagamentos_eventos').insert({ pagamento_id:payment.id,event_key:'synthetic-restore',tipo_evento:'SYNTHETIC',payload_filtrado:{synthetic:true} });
        const connection = testConnection();
        const args = ['--host',connection.host,'--port',String(connection.port),'--username',connection.user,'--dbname',connection.database];
        const processEnv = { ...process.env, PGPASSWORD:connection.password, PGOPTIONS:'' };
        const dump = join(directory,'synthetic.sql');
        await run(join(pgBin,'pg_dump.exe'),[...args,'--schema',source.schema,'--no-owner','--no-privileges','--file',dump],{env:processEnv,windowsHide:true,timeout:30000});
        const sql = await readFile(dump,'utf8');
        assert.ok(sql.includes('CREATE SCHEMA '+source.schema+';'));
        // Both schemas were created by this test. Production restore uses an empty database, without rewriting a dump.
        await writeFile(dump,sql.replace('CREATE SCHEMA '+source.schema+';','').replaceAll(source.schema,target.schema));
        await run(join(pgBin,'psql.exe'),[...args,'--no-psqlrc','--set','ON_ERROR_STOP=1','--file',dump],{env:processEnv,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
        for (const table of ['pedidos','itens_pedido','metodos_pagamento','pagamentos','pagamentos_eventos','infinitepay_credenciais','config_infinitepay','knex_migrations']) {
            assert.deepEqual(await target.db(table).orderBy('id'),await source.db(table).orderBy('id'),table);
        }
        const restored = await target.db('infinitepay_credenciais').first();
        assert.equal(decryptApiKey(restored,restored.handle),'SYNTHETIC_RESTORE_KEY');
        await assert.rejects(target.db('pagamentos').insert({ pedido_id:99999,tentativa_numero:1,order_nsu:'synthetic-invalid-parent',status:'INCERTA',valor_centavos:100,valid_until:'2050-01-01T00:00:00Z' }),{code:'23503'});
    } finally {
        for (const [name,value] of Object.entries(previous)) { if(value === undefined) delete process.env[name]; else process.env[name]=value; }
        await target.close(); await source.close();
        const resolved = await realpath(directory);
        assert.equal(dirname(resolved),temp); assert.ok(basename(resolved).startsWith('infinitepay-restore-'));
        await rm(resolved,{recursive:true,maxRetries:5,retryDelay:100});
    }
});

test('normal server boots in development on an isolated database without a test activation bypass', async () => {
    const fixture = await createTestDatabase(); let child;
    try {
        await fixture.db.migrate.latest();
        const connection = testConnection();
        const env = { ...process.env, NODE_ENV:'development',PORT:'0',DATABASE_URL:'',DB_HOST:connection.host,DB_PORT:String(connection.port),
            DB_USER:connection.user,DB_PASSWORD:connection.password,DB_NAME:connection.database,PGOPTIONS:'-c search_path='+fixture.schema,
            INFINITEPAY_MODE:'homologation',INFINITEPAY_DATABASE_NAME:connection.database,INFINITEPAY_CHECKOUT_ENABLED:'false',
            INFINITEPAY_PUBLIC_ORIGIN:'https://backend.invalid.test',INFINITEPAY_SUCCESS_URL:'https://shop.invalid.test/pedido/sucesso',
            INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'https://backend.invalid.test,https://shop.invalid.test',ALLOWED_ORIGINS:'https://shop.invalid.test',
            INFINITEPAY_ENCRYPTION_KEY:randomBytes(32).toString('base64'),INFINITEPAY_ENCRYPTION_KEYS:'',INFINITEPAY_ENCRYPTION_KEY_VERSION:'1' };
        child=spawn(process.execPath,['src/server.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let output='';child.stdout.on('data',part=>{output=(output+part).slice(-4000);});child.stderr.on('data',()=>{});
        const end=Date.now()+15000; let match;
        while(!(match=/API rodando na porta (\d+)/.exec(output))) {
            assert.equal(child.exitCode,null,'normal server must remain alive');
            assert.ok(Date.now()<end,'normal server must start with the isolated development configuration');
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        const response=await fetch('http://127.0.0.1:'+match[1]+'/pagamentos/consulta?ref=invalid');
        assert.equal(response.status,404,'normal runtime is installed, rather than returning unavailable');
        assert.equal((await fixture.db('config_infinitepay').first()).ativo,false);
        assert.equal(Number((await fixture.db('pagamentos').count('* as n').first()).n),0);
    } finally {
        if(child && child.exitCode === null) { const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit; }
        await fixture.close();
    }
});
