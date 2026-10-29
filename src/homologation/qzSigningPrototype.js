import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {infinitepaySessionCsrf} from '../utils/infinitepaySessionCsrf.js';
import {aplicarElegibilidadeOperacional} from '../utils/pedidoPaymentPolicy.js';

export const PROPOSED_QZ_PERMISSION='impressao.assinar';
class QzProtectionError extends Error {
    constructor(code='QZ_UNAVAILABLE',statusCode=503){super('Assinatura QZ indisponível.');this.code=code;this.statusCode=statusCode;}
}
const refuse=(code,status)=>{throw new QzProtectionError(code,status);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
function record(value,keys) {
    if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).some(key=>!keys.includes(key)))refuse('QZ_INVALID_REQUEST',400);
}
function canonical(value,depth=0) {
    if(depth>12)refuse('QZ_COMMAND_DENIED',403);
    if(value===null || ['string','boolean','number'].includes(typeof value))return value;
    if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
    record(value,Object.keys(value));return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]));
}
const paramsHash=value=>hash(JSON.stringify(canonical(value)));
function declaredScope(db) {
    const config=db?.client?.config,connection=config?.connection,schemas=config?.searchPath;
    if(!connection || connection.connectionString || !['127.0.0.1','localhost','::1'].includes(connection.host) ||
        !/^infinitepay_[a-z0-9_]*test$/.test(connection.database || '') || !Array.isArray(schemas) || schemas.length!==1 ||
        !/^iptest_[a-f0-9]{32}$/.test(schemas[0]))refuse();
    return {database:connection.database,schema:schemas[0]};
}

// Test-only composition: no operational key lookup, environment activation flag, table creation or router mounting.
export async function createQzSigningPrototype({db,origins,sessionSecret,signDigest,verifyDigest,deriveDocument,now=()=>new Date(),maxCalls=100}={}) {
    const scope=declaredScope(db);
    if(!Array.isArray(origins) || !origins.length || origins.some(value=>{try{return new URL(value).protocol!=='https:' || new URL(value).origin!==value;}catch{return true;}}) ||
        typeof sessionSecret!=='function' || typeof signDigest!=='function' || typeof verifyDigest!=='function' || typeof deriveDocument!=='function' || typeof now!=='function' ||
        !Number.isSafeInteger(maxCalls) || maxCalls<1 || maxCalls>1000)refuse();
    const allowedOrigins=new Set(origins);let deployment,lastTime=0;
    const time=()=>{const value=now();if(!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime()<lastTime)refuse();lastTime=value.getTime();return new Date(lastTime);};
    async function refresh(reader=db) {
        declaredScope(db);const actual=(await reader.raw('SELECT current_database() AS name,current_schema() AS schema')).rows[0];
        if(actual.name!==scope.database || actual.schema!==scope.schema)refuse();
        const marker=await reader('infinitepay_identidade_ambiente').where({id:1}).first();
        if(!uuid(marker?.identidade) || deployment && marker.identidade!==deployment)refuse();return marker.identidade;
    }
    deployment=await refresh();
    for(const name of ['qz_proto_estacoes','qz_proto_documentos','qz_proto_intencoes','qz_proto_auditoria'])if(!await db.schema.hasTable(name))refuse();
    function secret() {const value=sessionSecret();if(typeof value!=='string' || value.length<32 || value.length>8192)refuse();return value;}
    async function authenticate(session,{reader=db,csrf=true}={}) {
        record(session,['token','origin','csrf']);
        if(typeof session.token!=='string' || !session.token || session.token.length>8192 || !allowedOrigins.has(session.origin))refuse('QZ_AUTH_DENIED',403);
        const key=secret();let claims;
        try{claims=jwt.verify(session.token,key,{algorithms:['HS256'],clockTimestamp:Math.floor(time().getTime()/1000)});}catch{refuse('QZ_AUTH_DENIED',403);}
        if(!Number.isSafeInteger(claims.id) || claims.id<1 || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.iat>time().getTime()/1000)refuse('QZ_AUTH_DENIED',403);
        const expected=infinitepaySessionCsrf(session.token,key);
        if(csrf && (typeof session.csrf!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf) || !timingSafeEqual(Buffer.from(session.csrf),Buffer.from(expected))))refuse('QZ_AUTH_DENIED',403);
        const user=await reader('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
            .join('permissoes_usuarios as pu','pu.usuario_id','u.id').join('permissoes as p','p.id','pu.permissao_id')
            .where({'u.id':claims.id,'u.ativo':true,'n.ativo':true,'p.nome':PROPOSED_QZ_PERMISSION}).whereNull('u.deletado_em').first('u.id');
        // Same session fingerprint as the prepared durable administrative logout, without requiring financial permissions.
        const sessionHash=hash('infinitepay-admin-session-v1\0'+session.token);
        if(!user || await reader('infinitepay_sessoes_revogadas').where({implantacao_id:deployment,token_hash:sessionHash}).first())refuse('QZ_AUTH_DENIED',403);
        return {id:user.id,sessionHash};
    }
    const lock=(trx,actor)=>trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['qz-prototype:'+deployment+':'+actor.id]);
    const audit=(reader,operation,decision,code,actor,intentId=null)=>reader('qz_proto_auditoria').insert({operacao:operation,decisao:decision,codigo:code,
        usuario_id:actor?.id || null,intencao_id:intentId,criado_em:time()});
    async function quota(trx,actor) {
        const count=Number((await trx('qz_proto_auditoria').where({usuario_id:actor.id}).whereIn('operacao',['DOCUMENT','PREPARE','SIGN'])
            .whereNot('codigo','SIGNED').where('criado_em','>',new Date(time().getTime()-60000)).count('* as n').first()).n);
        if(count>=maxCalls)refuse('QZ_RATE_LIMIT',429);
    }
    async function execute(operation,request,action,{csrf=true}={}) {
        let actor,canAudit=false;
        try{await refresh();canAudit=true;actor=await authenticate(request?.session,{csrf});return await action(actor);}
        catch(error){const safe=error instanceof QzProtectionError?error:error.code==='23505'?new QzProtectionError('QZ_REPLAY',409):new QzProtectionError();
            if(canAudit)try{await audit(db,operation,'DENY',safe.code,actor);}catch{throw new QzProtectionError();}throw safe;}
    }
    function fresh(timestamp) {
        if(!Number.isSafeInteger(timestamp) || timestamp<1 || timestamp>time().getTime()+2000 || time().getTime()-timestamp>30000)refuse('QZ_COMMAND_DENIED',403);
    }
    async function approvedParams(reader,actor,{stationId,documentId,call}) {
        const station=await reader('qz_proto_estacoes').where({id:stationId,usuario_id:actor.id,ativo:true}).first();
        if(!station)refuse('QZ_COMMAND_DENIED',403);
        if(call==='printers.find') {
            if(documentId!==undefined && documentId!==null)refuse('QZ_INVALID_REQUEST',400);
            return {params:{query:station.impressora},bindingHash:paramsHash({user:actor.id,station:station.id,printer:station.impressora}),expiresAt:new Date(time().getTime()+15000)};
        }
        if(call!=='print' || !uuid(documentId))refuse('QZ_COMMAND_DENIED',403);
        const document=await reader('qz_proto_documentos').where({id:documentId,estacao_id:stationId}).first();
        if(!document || new Date(document.expira_em)<=time() || !await aplicarElegibilidadeOperacional(reader('pedidos'),{confirmedStates:['PAGA','LIQUIDADA']})
            .where({'pedidos.id':document.pedido_id}).whereNull('pedidos.deletado_em').first('pedidos.id'))refuse('QZ_COMMAND_DENIED',403);
        // A browser preimage is not a trusted document source. Derive again from server-owned order data.
        const derived=await deriveDocument({reader,station,document});
        if(!/^[a-f0-9]{64}$/.test(document.source_hash || '') || derived?.sourceHash!==document.source_hash || paramsHash(derived?.params)!==paramsHash(document.params))refuse('QZ_COMMAND_DENIED',403);
        const params=derived.params;
        record(params,['printer','options','data']);record(params.printer,['name']);
        if(params.printer.name!==station.impressora || Object.keys(params.printer).length!==1 || params.options?.copies!==1 ||
            !Array.isArray(params.data) || params.data.length!==1)refuse('QZ_COMMAND_DENIED',403);
        const item=params.data[0];record(item,['type','format','flavor','data']);
        if(item.type!=='pixel' || item.format!=='html' || item.flavor!=='plain' || typeof item.data!=='string' || !item.data || Buffer.byteLength(item.data)>32768)refuse('QZ_COMMAND_DENIED',403);
        return {params,bindingHash:paramsHash({user:actor.id,station:station.id,printer:station.impressora,document:document.id,order:document.pedido_id,source:document.source_hash}),
            expiresAt:new Date(Math.min(time().getTime()+15000,new Date(document.expira_em).getTime()))};
    }
    const storedAllowed=(reader,actor,row)=>approvedParams(reader,actor,{stationId:row.estacao_id,documentId:row.documento_id,call:row.chamada});
    async function bootstrap(request) {
        return execute('BOOTSTRAP',request,async actor=>{record(request,['session']);await audit(db,'BOOTSTRAP','ALLOW','CSRF_ISSUED',actor);
            return {csrfToken:infinitepaySessionCsrf(request.session.token,secret())};},{csrf:false});
    }
    async function prepare(request) {
        return execute('PREPARE',request,async actor=>{
            record(request,['session','stationId','documentId','request','message']);
            if(!uuid(request.stationId) || typeof request.request!=='string' || !/^[a-f0-9]{64}$/.test(request.request) ||
                typeof request.message!=='string' || Buffer.byteLength(request.message)>65536 || hash(request.message)!==request.request)refuse('QZ_INVALID_REQUEST',400);
            let command;try{command=JSON.parse(request.message);}catch{refuse('QZ_INVALID_REQUEST',400);}
            record(command,['call','params','timestamp']);
            if(Object.keys(command).join(',')!=='call,params,timestamp' || JSON.stringify(command)!==request.message)refuse('QZ_INVALID_REQUEST',400);
            fresh(command.timestamp);
            return db.transaction(async trx=>{
                await lock(trx,actor);await authenticate(request.session,{reader:trx});await quota(trx,actor);
                const allowed=await approvedParams(trx,actor,{stationId:request.stationId,documentId:request.documentId,call:command.call});
                const parameters=paramsHash(allowed.params);if(paramsHash(command.params)!==parameters)refuse('QZ_COMMAND_DENIED',403);
                const id=randomUUID();await trx('qz_proto_intencoes').insert({id,usuario_id:actor.id,sessao_hash:actor.sessionHash,estacao_id:request.stationId,
                    documento_id:request.documentId || null,chamada:command.call,request_digest:request.request,params_hash:parameters,operacao_hash:allowed.bindingHash,request_timestamp:command.timestamp,
                    estado:'RESERVADA',criado_em:time(),expira_em:allowed.expiresAt});
                await audit(trx,'PREPARE','ALLOW','INTENT_CREATED',actor,id);return {intentId:id,expiresAt:allowed.expiresAt.toISOString()};
            });
        });
    }
    async function issueDocument(request) {
        return execute('DOCUMENT',request,async actor=>{
            record(request,['session','stationId','pedidoId']);
            if(!uuid(request.stationId) || !Number.isSafeInteger(request.pedidoId) || request.pedidoId<1)refuse('QZ_INVALID_REQUEST',400);
            return db.transaction(async trx=>{
                await lock(trx,actor);await authenticate(request.session,{reader:trx});await quota(trx,actor);
                await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['qz-document:'+deployment+':'+request.pedidoId]);
                const station=await trx('qz_proto_estacoes').where({id:request.stationId,usuario_id:actor.id,ativo:true}).first();
                if(!station || !await aplicarElegibilidadeOperacional(trx('pedidos'),{confirmedStates:['PAGA','LIQUIDADA']})
                    .where({'pedidos.id':request.pedidoId}).whereNull('pedidos.deletado_em').first('pedidos.id'))refuse('QZ_COMMAND_DENIED',403);
                let document=await trx('qz_proto_documentos').where({pedido_id:request.pedidoId}).first();
                if(document && (document.estacao_id!==station.id || new Date(document.expira_em)<=time()))refuse('QZ_COMMAND_DENIED',403);
                const existing=Boolean(document);
                if(!document) {
                    const draft={id:randomUUID(),estacao_id:station.id,pedido_id:request.pedidoId},derived=await deriveDocument({reader:trx,station,document:draft});
                    if(!/^[a-f0-9]{64}$/.test(derived?.sourceHash || ''))refuse('QZ_COMMAND_DENIED',403);
                    [document]=await trx('qz_proto_documentos').insert({...draft,params:derived.params,source_hash:derived.sourceHash,expira_em:new Date(time().getTime()+300000)}).returning('*');
                }
                const allowed=await approvedParams(trx,actor,{stationId:station.id,documentId:document.id,call:'print'});
                await audit(trx,'DOCUMENT','ALLOW',existing?'DOCUMENT_REUSED':'DOCUMENT_CREATED',actor);
                return {documentId:document.id,stationId:station.id,pedidoId:document.pedido_id,printer:station.impressora,params:allowed.params,expiresAt:new Date(document.expira_em).toISOString()};
            });
        });
    }
    async function sign(request) {
        return execute('SIGN',request,async actor=>{
            record(request,['session','intentId','request']);
            if(!uuid(request.intentId) || typeof request.request!=='string' || !/^[a-f0-9]{64}$/.test(request.request))refuse('QZ_INVALID_REQUEST',400);
            const claimed=await db.transaction(async trx=>{
                await lock(trx,actor);await authenticate(request.session,{reader:trx});await quota(trx,actor);
                const row=await trx('qz_proto_intencoes').where({id:request.intentId}).forUpdate().first();
                if(!row || row.usuario_id!==actor.id || row.sessao_hash!==actor.sessionHash || row.request_digest!==request.request)refuse('QZ_AUTH_DENIED',403);
                if(row.estado!=='RESERVADA' || new Date(row.expira_em)<=time())refuse('QZ_REPLAY',409);
                fresh(Number(row.request_timestamp));const allowed=await storedAllowed(trx,actor,row);
                if(paramsHash(allowed.params)!==row.params_hash || allowed.bindingHash!==row.operacao_hash)refuse('QZ_COMMAND_DENIED',403);
                await trx('qz_proto_intencoes').where({id:row.id}).update({estado:'CONSUMIDA'});
                await audit(trx,'SIGN','ALLOW','SIGN_CLAIMED',actor,row.id);return row;
            });
            // A durable, one-use claim precedes key use. No failed/abandoned claim is automatically retried.
            await authenticate(request.session);const allowed=await storedAllowed(db,actor,claimed);
            if(paramsHash(allowed.params)!==claimed.params_hash || allowed.bindingHash!==claimed.operacao_hash)refuse('QZ_COMMAND_DENIED',403);
            if(new Date(claimed.expira_em)<=time())refuse('QZ_REPLAY',409);
            fresh(Number(claimed.request_timestamp));
            const signature=await signDigest(request.request);
            if(typeof signature!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length>2048 || await verifyDigest(request.request,signature)!==true)refuse();
            await db.transaction(async trx=>{
                await lock(trx,actor);await authenticate(request.session,{reader:trx});
                const row=await trx('qz_proto_intencoes').where({id:claimed.id,estado:'CONSUMIDA'}).forUpdate().first();
                if(!row || new Date(row.expira_em)<=time())refuse('QZ_COMMAND_DENIED',403);
                const final=await storedAllowed(trx,actor,row);
                if(paramsHash(final.params)!==row.params_hash || final.bindingHash!==row.operacao_hash)refuse('QZ_COMMAND_DENIED',403);
                if(new Date(row.expira_em)<=time())refuse('QZ_COMMAND_DENIED',403);fresh(Number(row.request_timestamp));
                await audit(trx,'SIGN','ALLOW','SIGNED',actor,row.id);
                if(new Date(row.expira_em)<=time())refuse('QZ_COMMAND_DENIED',403);
                await trx('qz_proto_intencoes').where({id:row.id}).update({estado:'ASSINADA'});
                if(new Date(row.expira_em)<=time())refuse('QZ_COMMAND_DENIED',403);
            });
            // A slow commit may consume the claim without returning the signature.
            if(new Date(claimed.expira_em)<=time())refuse('QZ_COMMAND_DENIED',403);fresh(Number(claimed.request_timestamp));
            return signature;
        });
    }
    return Object.freeze({bootstrap,issueDocument,prepare,sign});
}
