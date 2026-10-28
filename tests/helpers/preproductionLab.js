import {mkdtemp,mkdir,readFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import knex from 'knex';
import {migrations,testConnection} from './testDatabase.js';

const database='infinitepay_preproduction_test',user='preprod_test';
const failure=()=>Object.assign(new Error('Infraestrutura sintética de pré-produção indisponível.'),{code:'PREPRODUCTION_TOOL_FAILED'});
const pgBin=process.env.PREPRODUCTION_PG_BIN || (process.platform==='win32'?'C:/Program Files/PostgreSQL/18/bin':'');
const tool=name=>pgBin?join(pgBin,name+(process.platform==='win32'?'.exe':'')):name;
const toolEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|TOKEN|SECRET|PASSWORD|KEY|^DB_|DATABASE/i.test(key)));
async function run(program,args,allowed=[0]) {
    return new Promise((resolve,reject)=>{
        const child=spawn(program,args,{windowsHide:true,stdio:'ignore',env:toolEnv()});let timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
        child.once('error',()=>{clearTimeout(timer);reject(failure());});
        child.once('exit',code=>{clearTimeout(timer);if(timedOut || !allowed.includes(code))reject(failure());else resolve(code);});
    });
}
async function freePort() {
    const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export async function closePreproductionResources({fixtures,clusters,removeRoot}) {
    const closed=[];
    for(const fixture of [...fixtures].reverse())try{await fixture.close();closed.push({status:'fulfilled'});}catch{closed.push({status:'rejected'});}
    const stopped=await Promise.allSettled([...clusters].reverse().map(cluster=>Promise.resolve().then(()=>cluster.stop())));
    let removalFailed=false;
    if(stopped.every(result=>result.status==='fulfilled'))try{await removeRoot();}catch{removalFailed=true;}
    if(removalFailed || [...closed,...stopped].some(result=>result.status==='rejected'))throw failure();
}
export async function createPreproductionLab() {
    const root=await realpath(await mkdtemp(join(tmpdir(),'infinitepay-preproduction-'))),canonical=root,clusters=[],fixtures=new Set();
    const owned=path=>{const target=resolve(path);if(!target.startsWith(resolve(canonical)+sep))throw failure();return target;};
    const connection=cluster=>testConnection(`postgresql://${user}@127.0.0.1:${cluster.port}/${database}`);
    const open=(cluster,schema)=>knex({client:'pg',connection:connection(cluster),searchPath:[schema],pool:{min:0,max:6},
        migrations:{directory:migrations,schemaName:schema}});
    async function cluster(name) {
        const directory=owned(join(root,name)),port=await freePort();await mkdir(directory);
        const c={directory,port,started:false,stop:async()=>{}};clusters.push(c);
        await run(tool('initdb'),['-D',directory,'-U',user,'-A','trust','--encoding=UTF8','--no-locale']);
        c.start=async()=>{await run(tool('pg_ctl'),['-D',directory,'-l',owned(join(root,name+'.log')),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);c.started=true;};
        c.stop=async(mode='fast')=>{if(!['fast','immediate'].includes(mode))throw failure();const status=await run(tool('pg_ctl'),['-D',directory,'status'],[0,3]);
            if(status===0)await run(tool('pg_ctl'),['-D',directory,'-m',mode,'-w','stop']);c.started=false;};
        await c.start();
        await run(tool('createdb'),['--host=127.0.0.1','--port='+port,'--username='+user,'--no-password',database]);
        const probe=open(c,'public');
        try {
            const actual=(await probe.raw('SELECT current_database() AS name,inet_server_port() AS port,current_setting(\'data_directory\') AS directory')).rows[0];
            if(actual.name!==database || actual.port!==port || resolve(actual.directory).toLowerCase()!==resolve(directory).toLowerCase())throw failure();
        }finally{await probe.destroy();}
        return c;
    }
    async function close() {
        await closePreproductionResources({fixtures,clusters,async removeRoot(){
            if(await realpath(root)!==canonical || !basename(root).startsWith('infinitepay-preproduction-'))throw failure();
            // Only this invocation's new temporary clusters, certificates and synthetic dump are removed after confirmed stops.
            await rm(canonical,{recursive:true,force:true});
        }});
    }
    try {
        const source=await cluster('source'),target=await cluster('restore');
        const openssl=process.env.PREPRODUCTION_OPENSSL || (process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
        const keyPath=owned(join(root,'localhost-key.pem')),certPath=owned(join(root,'localhost-cert.pem'));
        await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1',
            '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
        const tls={key:await readFile(keyPath),cert:await readFile(certPath)};
        const {createPreproductionFixture}=await import('./preproductionFixture.js');
        async function fixture(extra={}) {
            const c=extra.cluster || source,schema=extra.schema || 'iptest_'+randomUUID().replaceAll('-','');
            if(!/^iptest_[a-f0-9]{32}$/.test(schema) || !clusters.includes(c))throw failure();
            if(!extra.restored){const admin=open(c,'public');try{await admin.raw('CREATE SCHEMA ??',[schema]);}finally{await admin.destroy();}}
            const f=await createPreproductionFixture({db:open(c,schema),schema,tls,...extra,connection:connection(c),
                async restartDatabase(oldDb){await oldDb.destroy();await c.stop('immediate');await c.start();return open(c,schema);}});
            const previous=f.close;f.close=async()=>{try{await previous();}finally{fixtures.delete(f);}};fixtures.add(f);return f;
        }
        async function restore(f) {
            if(!fixtures.has(f) || f.db.client.config.connection.port!==source.port)throw failure();
            await f.quiesce();
            const dump=owned(join(root,'synthetic-'+randomUUID()+'.dump'));
            const args=c=>['--host=127.0.0.1','--port='+c.port,'--username='+user,'--no-password','--dbname='+database];
            await run(tool('pg_dump'),[...args(source),'--format=custom','--no-owner','--no-acl','--schema='+f.schema,'--file='+dump]);
            const probe=open(target,'public');try{if((await probe.raw('SELECT 1 FROM pg_namespace WHERE nspname=?',[f.schema])).rows.length)throw failure();}finally{await probe.destroy();}
            await run(tool('pg_restore'),[...args(target),'--no-owner','--no-acl','--exit-on-error',dump]);
            const metadata={bytes:(await stat(dump)).size,sha256:createHash('sha256').update(await readFile(dump)).digest('hex')};
            if(!metadata.bytes)throw failure();
            return fixture({cluster:target,schema:f.schema,restored:true,identity:f.env.INFINITEPAY_DATABASE_ID,clock:f.clock,
                sessionSecret:f.sessionSecret,receiverSecret:f.receiverSecret,encryptionKey:f.encryptionKey,backupMetadata:metadata});
        }
        return {fixture,restore,close};
    }catch(error){await close();throw error;}
}
