import express from 'express';
import cookieParser from 'cookie-parser';
import {createServer,request as httpsRequest} from 'node:https';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createRequire} from 'node:module';
import {createHash,createPrivateKey,sign,verify,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {createTestDatabase} from './testDatabase.js';
import {infinitepaySessionCsrf} from '../../src/utils/infinitepaySessionCsrf.js';
import {createQzSigningPrototype,PROPOSED_QZ_PERMISSION} from '../../src/homologation/qzSigningPrototype.js';
import {createQzSigningPrototypeRouter} from '../../src/homologation/qzSigningPrototypeRoutes.js';

const require=createRequire(import.meta.url);
export const syntheticQz=require('../../../Saas-Marmitaria-Frontend/node_modules/qz-tray/qz-tray.js');
export const printerOptions={units:'mm',margins:{top:0,right:0,bottom:0,left:0},orientation:'portrait',scaleContent:false};
const printerName='SYNTHETIC_PRINTER';
export async function createSyntheticQzIdentity() {
    const directory=await mkdtemp(join(tmpdir(),'qz-signing-fixture-')),keyPath=join(directory,'synthetic.key'),certPath=join(directory,'synthetic.crt');
    const cleanup=async()=>{
        const target=resolve(directory);
        if(dirname(target)!==resolve(tmpdir()) || !basename(target).startsWith('qz-signing-fixture-'))throw new Error('Limpeza sintética recusada.');
        await rm(target,{recursive:true,force:true});
    };
    try {
        await new Promise((accept,reject)=>{
            const process=spawn('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyPath,'-out',certPath,
                '-subj','/CN=localhost/O=SYNTHETIC QZ TEST ONLY','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore',windowsHide:true});
            process.once('error',reject);process.once('exit',code=>code===0?accept():reject(new Error('Certificado sintético indisponível.')));
        });
        const key=await readFile(keyPath),cert=await readFile(certPath),privateKey=createPrivateKey(key),publicIdentity=new X509Certificate(cert);
        return {cert:cert.toString(),tls:{key,cert},fingerprint:publicIdentity.fingerprint256,
            sign:digest=>sign('RSA-SHA512',Buffer.from(digest,'utf8'),privateKey).toString('base64'),
            verify:(digest,signature)=>verify('RSA-SHA512',Buffer.from(digest,'utf8'),publicIdentity.publicKey,Buffer.from(signature,'base64')),
            async close(){key.fill(0);await cleanup();}};
    }catch(error){await cleanup();throw error;}
}

async function prototypeTables(db) {
    await db.schema.createTable('qz_proto_estacoes',t=>{
        t.uuid('id').primary();t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.text('impressora').notNullable();t.boolean('ativo').notNullable().defaultTo(true);
    });
    await db.schema.createTable('qz_proto_documentos',t=>{
        t.uuid('id').primary();t.uuid('estacao_id').notNullable().references('id').inTable('qz_proto_estacoes').onDelete('RESTRICT');
        t.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');t.jsonb('params').notNullable();t.timestamp('expira_em',{useTz:true}).notNullable();
    });
    await db.schema.createTable('qz_proto_intencoes',t=>{
        t.uuid('id').primary();t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');t.string('sessao_hash',64).notNullable();
        t.uuid('estacao_id').notNullable().references('id').inTable('qz_proto_estacoes').onDelete('RESTRICT');
        t.uuid('documento_id').unique().references('id').inTable('qz_proto_documentos').onDelete('RESTRICT');
        t.text('chamada').notNullable();t.string('request_digest',64).notNullable().unique();t.string('params_hash',64).notNullable();t.bigInteger('request_timestamp').notNullable();
        t.text('estado').notNullable();t.check("estado IN ('RESERVADA','CONSUMIDA','ASSINADA')");
        t.timestamp('criado_em',{useTz:true}).notNullable();t.timestamp('expira_em',{useTz:true}).notNullable();
    });
    await db.schema.createTable('qz_proto_auditoria',t=>{
        t.bigIncrements('id');t.integer('usuario_id').references('id').inTable('usuarios').onDelete('RESTRICT');
        t.uuid('intencao_id').references('id').inTable('qz_proto_intencoes').onDelete('RESTRICT');t.string('operacao',20).notNullable();
        t.string('decisao',5).notNullable();t.string('codigo',40).notNullable();t.timestamp('criado_em',{useTz:true}).notNullable();t.index(['usuario_id','criado_em']);
    });
}

export async function createQzSigningFixture(identity) {
    const database=await createTestDatabase(),f={db:database.db,schema:database.schema,clock:new Date(),signCalls:0,signFailure:false},servers=new Set();
    const sessionSecret=randomBytes(32).toString('base64');
    f.advance=ms=>{f.clock=new Date(f.clock.getTime()+ms);};
    f.close=async()=>{
        const results=await Promise.allSettled([...servers].map(close=>close()));
        try{await database.close();}finally{if(results.some(result=>result.status==='rejected'))throw new Error('Encerramento HTTPS incompleto.');}
    };
    try {
        await f.db.migrate.latest();await prototypeTables(f.db);
        const [role]=await f.db('niveis_acesso').insert({nome:'admin',descricao:'SYNTHETIC ONLY'}).returning('*');
        [f.actor]=await f.db('usuarios').insert({nome:'SYNTHETIC',email:'qz@invalid.test',senha_hash:'SYNTHETIC',nivel_acesso_id:role.id}).returning('*');
        const [permission]=await f.db('permissoes').insert({nome:PROPOSED_QZ_PERMISSION,descricao:'PROPOSED; SYNTHETIC FIXTURE ONLY'}).returning('*');
        await f.db('permissoes_usuarios').insert({usuario_id:f.actor.id,permissao_id:permission.id});
        await f.db('metodos_pagamento').insert([['DINHEIRO','DINHEIRO'],['CARTAO_DEBITO','DEBITO'],['PIX','PIX']].map(([codigo,tipo_financeiro])=>({nome:'SYNTHETIC '+codigo,codigo,tipo_financeiro})));
        [f.station]=await f.db('qz_proto_estacoes').insert({id:randomUUID(),usuario_id:f.actor.id,impressora:printerName}).returning('*');
        f.token=({wrongSecret=false,expired=false}={})=>{
            const seconds=Math.floor(f.clock.getTime()/1000);
            return jwt.sign({id:f.actor.id,iat:seconds-1,exp:seconds+(expired?-1:3600),jti:randomUUID()},wrongSecret?'WRONG_SYNTHETIC_SECRET':sessionSecret,{algorithm:'HS256'});
        };
        f.useToken=token=>{f.session={token,origin:'https://shop.invalid.test',csrf:token?infinitepaySessionCsrf(token,sessionSecret):''};};f.useToken(f.token());
        f.document=async({online=false,status='AGUARDANDO',verified=false,method='DINHEIRO'}={})=>{
            const paymentMethod=await f.db('metodos_pagamento').where({codigo:online?'PIX':method}).first();
            const [order]=await f.db('pedidos').insert({nome_cliente:'SYNTHETIC QZ',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
                metodo_pagamento_id:paymentMethod.id,valor_total:1,fluxo_pagamento:online?'INFINITEPAY':'POSTERIOR',liberado_cozinha_em:verified?f.clock:null}).returning('*');
            if(online)await f.db('pagamentos').insert({pedido_id:order.id,tentativa_numero:1,order_nsu:'SYNTHETIC-'+randomUUID(),status,valor_centavos:100,
                valid_until:new Date(f.clock.getTime()+3600000),...(verified?{provider_verified_at:f.clock,pago_em:f.clock,transaction_nsu:'SYNTHETIC-TXN-'+randomUUID(),
                    invoice_slug:'SYNTHETIC-SLUG-'+randomUUID(),capture_method:'pix',valor_base_provider_centavos:100}:{} )});
            const config=syntheticQz.configs.create(printerName,printerOptions);
            // getOptions requires a connected Tray for version adaptation; the fake-transport harness checks these 2.2.6 defaults.
            const params={printer:config.getPrinter(),options:structuredClone(config.config),data:[{type:'pixel',format:'html',flavor:'plain',data:'<html><body>SYNTHETIC APPROVED DOCUMENT '+order.id+'</body></html>'}]};
            const [doc]=await f.db('qz_proto_documentos').insert({id:randomUUID(),estacao_id:f.station.id,pedido_id:order.id,params,expira_em:new Date(f.clock.getTime()+300000)}).returning('*');return doc;
        };
        f.doc=await f.document();
        f.anotherService=options=>createQzSigningPrototype({db:f.db,origins:['https://shop.invalid.test'],sessionSecret:()=>sessionSecret,now:()=>new Date(f.clock),
            signDigest:async digest=>{f.signCalls++;if(f.signFailure)throw new Error('SYNTHETIC_PRIVATE_SECRET');await f.onSign?.();return identity.sign(digest);},verifyDigest:identity.verify,...options});
        f.service=await f.anotherService();
        f.additionalServer=async({globalLimit=100}={})=>{
            const app=express();app.use(cookieParser());app.use(createQzSigningPrototypeRouter({service:f.service,globalLimit}));
            const server=createServer(identity.tls,app);await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
            let closed=false;
            const close=async()=>{if(closed)return;closed=true;server.closeAllConnections();await new Promise(accept=>server.close(accept));servers.delete(close);};servers.add(close);
            const request=(path,body,{method='POST',headers={}}={})=>new Promise((accept,reject)=>{
                const payload=body===undefined?undefined:JSON.stringify(body);
                const req=httpsRequest({hostname:'127.0.0.1',port:server.address().port,path,method,servername:'localhost',ca:identity.tls.cert,
                    headers:{Origin:f.session.origin,Cookie:'token='+f.session.token,'X-Infinitepay-CSRF':f.session.csrf || '',
                        ...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}),...headers}},response=>{
                    let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}accept({status:response.statusCode,headers:response.headers,text,data});});
                });req.setTimeout(10000,()=>req.destroy(new Error('HTTPS sintético indisponível.')));req.once('error',reject);req.end(payload);
            });request.close=close;return request;
        };
        f.request=await f.additionalServer();
        f.bootstrap=async()=>{const response=await f.request('/csrf',undefined,{method:'GET'});if(response.status!==200)throw new Error('CSRF sintético recusado.');f.session.csrf=response.data.csrfToken;};
        f.command=(call='printers.find',doc=f.doc)=>{
            const message=JSON.stringify({call,params:call==='print'?doc.params:{query:printerName},timestamp:f.clock.getTime()});
            return {stationId:f.station.id,...(call==='print'?{documentId:doc.id}:{}),message,request:createHash('sha256').update(message).digest('hex')};
        };
        f.failAudit=async code=>{
            if(!['SIGN_CLAIMED','SIGNED'].includes(code))throw new Error('Falha sintética recusada.');
            await f.db.raw(`CREATE FUNCTION reject_qz_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.codigo = '${code}' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
            await f.db.raw('CREATE TRIGGER reject_qz_audit BEFORE INSERT ON qz_proto_auditoria FOR EACH ROW EXECUTE FUNCTION reject_qz_audit()');
        };
        return f;
    }catch(error){await f.close();throw error;}
}
