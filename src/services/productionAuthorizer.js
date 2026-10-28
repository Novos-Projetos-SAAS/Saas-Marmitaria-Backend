import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {validateProductionEnvironment,assertProductionDatabase} from '../config/infinitepayProduction.js';
import {decryptApiKey} from '../utils/infinitepayCredentials.js';
import {infinitepaySessionCsrf} from '../utils/infinitepaySessionCsrf.js';

const capabilities=new Set(['WORKER','CREATE_LINK','VERIFY_PAYMENT','DELIVER_ORDER']);
const auditOperations=new Set([...capabilities,'APPROVE','REVOKE','EMERGENCY_STOP']);
const id=value=>Number.isSafeInteger(value) && value>0 || typeof value==='string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
class AuthorizationError extends Error {
    constructor(code='AUTHORIZATION_DENIED'){super('Autorização de produção indisponível.');this.code=code;}
}
const refuse=code=>{throw new AuthorizationError(code);};
function record(value,keys) {
    if(!value || Array.isArray(value) || typeof value!=='object' || Object.keys(value).some(key=>!keys.includes(key))) refuse('INVALID_REQUEST');
}
function equalHex(a,b) {return /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '') && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}

// Internal control plane only: constructing this service neither grants nor installs any authorization.
export function createProductionAuthorizer({db,env,now=()=>new Date(),sessionSecret=()=>process.env.JWT_SECRET}={}) {
    const config=validateProductionEnvironment(env);
    if(typeof db!=='function' || typeof db.transaction!=='function' || typeof now!=='function' || typeof sessionSecret!=='function') throw new TypeError('Contrato de autorização inválido.');
    const bootId=randomUUID(),bootKey=randomBytes(32),revoked=new Set();let halted=false,lastInstant=0;
    const time=()=>{
        const value=now();if(!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime()<lastInstant)refuse('CLOCK_INVALID');
        lastInstant=value.getTime();return new Date(lastInstant);
    };
    function secret() {const value=sessionSecret();if(typeof value!=='string' || value.length<32 || value.length>8192)refuse('SESSION_UNAVAILABLE');return value;}
    const secretHash=()=>createHmac('sha256',bootKey).update(secret()).digest('hex');
    async function refresh() {
        if(JSON.stringify(validateProductionEnvironment(env))!==JSON.stringify(config))refuse('ENVIRONMENT_CHANGED');
        await assertProductionDatabase(db,config);
    }
    async function audit(reader,operation,decision,code,{approvalId=null,userId=null}={}) {
        await reader('infinitepay_autorizacao_decisoes').insert({boot_id:bootId,autorizacao_id:approvalId,usuario_id:userId,
            operacao:auditOperations.has(operation)?operation:'INVALID',decisao:decision,codigo:code,criado_em:time()});
    }
    async function hasPermission(reader,userId) {
        return Boolean(await reader('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
            .join('permissoes_usuarios as pu','pu.usuario_id','u.id').join('permissoes as p','p.id','pu.permissao_id')
            .where({'u.id':userId,'u.ativo':true,'n.ativo':true,'p.nome':'pagamentos.ativar_producao'}).whereNull('u.deletado_em').first('u.id'));
    }
    async function administrator(session) {
        try {
            record(session,['token','origin','csrf']);
            if(typeof session.token!=='string' || session.token.length>8192)refuse();
            const origin=new URL(session.origin);
            if(origin.protocol!=='https:' || origin.origin!==session.origin ||
                !(env.ALLOWED_ORIGINS || '').split(',').map(v=>v.trim()).includes(session.origin) ||
                !(env.INFINITEPAY_ALLOWED_PUBLIC_ORIGINS || '').split(',').map(v=>v.trim()).includes(session.origin))refuse();
            const key=secret(),expected=infinitepaySessionCsrf(session.token,key);
            if(typeof session.csrf!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf) ||
                !timingSafeEqual(Buffer.from(session.csrf),Buffer.from(expected)))refuse();
            const claims=jwt.verify(session.token,key,{algorithms:['HS256'],clockTimestamp:Math.floor(time().getTime()/1000)});
            if(!Number.isSafeInteger(claims.id) || claims.id<1 || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) ||
                claims.iat>Math.floor(time().getTime()/1000) || !await hasPermission(db,claims.id))refuse();
            return {id:claims.id,expiresAt:new Date(claims.exp*1000)};
        } catch {refuse('ADMINISTRATION_DENIED');}
    }
    async function credential(reader,credentialId) {
        if(!id(credentialId))refuse('CREDENTIAL_INVALID');
        const row=await reader('infinitepay_credenciais').where({id:credentialId,config_id:1}).first();
        if(!row || !/^[\x21-\x7E]{1,4096}$/.test(decryptApiKey(row,row.handle)))refuse('CREDENTIAL_INVALID');
        const fingerprint=createHash('sha256').update(JSON.stringify([row.id,row.config_id,row.handle,row.key_version,row.api_key_ciphertext,row.api_key_iv,row.api_key_tag])).digest('hex');
        return {row,fingerprint};
    }
    function signature(row) {
        return createHmac('sha256',bootKey).update(JSON.stringify([row.id,row.boot_id,row.implantacao_id,row.banco,row.ambiente,row.origem_https,
            String(row.credencial_id),row.credencial_hash,row.chave_sessao_hash,[...row.capacidades].sort(),row.destino ?? null,row.aprovado_por,
            new Date(row.criado_em).toISOString(),new Date(row.expira_em).toISOString()])).digest('hex');
    }
    async function administrative(operation,request,action) {
        let actor,canAudit=false;
        try {await refresh();canAudit=true;actor=await administrator(request?.session);return await action(actor);}
        catch(error) {
            if(canAudit) {try{await audit(db,operation,'DENY',error instanceof AuthorizationError?error.code:'ADMINISTRATION_FAILED',{userId:actor?.id});}catch{}}
            throw new AuthorizationError(error instanceof AuthorizationError?error.code:'ADMINISTRATION_FAILED');
        }
    }
    async function approve(request) {
        return administrative('APPROVE',request,async actor=>{
            record(request,['session','capabilities','validForSeconds','credentialId','destinationId']);
            if(halted)refuse('EMERGENCY_STOP');
            const ttl=request.validForSeconds ?? 300,caps=request.capabilities;
            if(!Number.isInteger(ttl) || ttl<1 || ttl>900 || !Array.isArray(caps) || !caps.length ||
                new Set(caps).size!==caps.length || caps.some(value=>!capabilities.has(value)))refuse('INVALID_CAPABILITIES');
            if(caps.includes('DELIVER_ORDER') ? typeof request.destinationId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(request.destinationId) :
                request.destinationId!==undefined)refuse('INVALID_DESTINATION');
            return db.transaction(async trx=>{
                await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['infinitepay:production-authorization:'+config.databaseId+':'+bootId]);
                if(halted || !await hasPermission(trx,actor.id))refuse('ADMINISTRATION_DENIED');
                const settings=await trx('config_infinitepay').where({id:1}).first();
                const credentialId=request.credentialId ?? settings.credencial_atual_id,{fingerprint,row:stored}=await credential(trx,credentialId);
                if(String(credentialId)===String(settings.credencial_atual_id) && settings.handle!==stored.handle)refuse('CREDENTIAL_INVALID');
                if(String(credentialId)!==String(settings.credencial_atual_id) && caps.some(value=>!['WORKER','VERIFY_PAYMENT'].includes(value)))refuse('HISTORICAL_CREDENTIAL_SCOPE');
                const instant=time(),expires=new Date(Math.min(instant.getTime()+ttl*1000,actor.expiresAt.getTime()));
                if(expires<=instant)refuse('SESSION_EXPIRED');
                await trx('infinitepay_autorizacoes_producao').where({boot_id:bootId,credencial_id:credentialId}).whereNull('revogado_em').update({revogado_em:instant});
                const row={id:randomUUID(),boot_id:bootId,implantacao_id:config.databaseId,banco:config.database,ambiente:'production',origem_https:config.publicOrigin,
                    credencial_id:credentialId,credencial_hash:fingerprint,chave_sessao_hash:secretHash(),capacidades:[...caps].sort(),destino:request.destinationId ?? null,
                    aprovado_por:actor.id,criado_em:instant,expira_em:expires};
                row.assinatura=signature(row);await trx('infinitepay_autorizacoes_producao').insert(row);
                await audit(trx,'APPROVE','ALLOW','EXPLICIT_ADMIN_APPROVAL',{approvalId:row.id,userId:actor.id});
                return {id:row.id,expiresAt:expires.toISOString(),capabilities:row.capacidades};
            });
        });
    }
    function scope(context) {
        record(context,['operation','database','databaseId','deploymentId','environment','publicOrigin','credentialId','destinationId']);
        return capabilities.has(context.operation) && context.database===config.database && context.databaseId===config.databaseId &&
            context.deploymentId===config.databaseId && context.environment==='production' && context.publicOrigin===config.publicOrigin &&
            (context.operation!=='DELIVER_ORDER' || typeof context.destinationId==='string') &&
            (context.credentialId===undefined || id(context.credentialId));
    }
    async function authorize(context) {
        let canAudit=false;
        try {
            await refresh();canAudit=true;
            if(!scope(context) || halted) {await audit(db,context?.operation,'DENY',halted?'EMERGENCY_STOP':'INVALID_SCOPE');return false;}
            return await db.transaction(async trx=>{
                const settings=await trx('config_infinitepay').where({id:1}).first();
                const chosen=context.credentialId ?? (['CREATE_LINK','DELIVER_ORDER'].includes(context.operation)?settings.credencial_atual_id:undefined);
                const query=trx('infinitepay_autorizacoes_producao').where({boot_id:bootId,implantacao_id:config.databaseId})
                    .whereNull('revogado_em').where('criado_em','<=',time()).where('expira_em','>',time()).whereRaw('? = ANY(capacidades)',[context.operation]);
                if(chosen!==undefined)query.where({credencial_id:chosen});
                if(context.operation==='DELIVER_ORDER')query.where({destino:context.destinationId});
                for(const approval of await query.orderBy('criado_em','desc').forShare()) {
                    if(revoked.has(approval.id) || !equalHex(approval.assinatura,signature(approval)) ||
                        approval.banco!==config.database || approval.ambiente!=='production' || approval.origem_https!==config.publicOrigin ||
                        !equalHex(approval.chave_sessao_hash,secretHash()) || !await hasPermission(trx,approval.aprovado_por))continue;
                    if(['CREATE_LINK','DELIVER_ORDER'].includes(context.operation) && String(approval.credencial_id)!==String(settings.credencial_atual_id))continue;
                    const {fingerprint,row:stored}=await credential(trx,approval.credencial_id);
                    if(String(approval.credencial_id)===String(settings.credencial_atual_id) && settings.handle!==stored.handle)continue;
                    if(!equalHex(approval.credencial_hash,fingerprint) || halted || revoked.has(approval.id) || new Date(approval.expira_em)<=time())continue;
                    await audit(trx,context.operation,'ALLOW','CAPABILITY_APPROVED',{approvalId:approval.id,userId:approval.aprovado_por});
                    return !halted && !revoked.has(approval.id);
                }
                await audit(trx,context.operation,'DENY','NO_VALID_APPROVAL');return false;
            });
        }catch{if(canAudit){try{await audit(db,context?.operation,'DENY','AUTHORIZATION_UNAVAILABLE');}catch{}}return false;}
    }
    async function revoke(request) {
        return administrative('REVOKE',request,async actor=>{
            record(request,['session','id']);if(!uuid(request.id))refuse('INVALID_REQUEST');revoked.add(request.id);
            return db.transaction(async trx=>{
                const changed=await trx('infinitepay_autorizacoes_producao').where({id:request.id,implantacao_id:config.databaseId}).whereNull('revogado_em')
                    .update({revogado_em:time()});
                await audit(trx,'REVOKE',changed?'ALLOW':'DENY',changed?'EXPLICIT_REVOCATION':'APPROVAL_NOT_ACTIVE',{userId:actor.id,...(changed?{approvalId:request.id}:{})});
                return changed>0;
            });
        });
    }
    async function emergencyStop(request) {
        return administrative('EMERGENCY_STOP',request,async actor=>{
            record(request,['session']);halted=true;
            return db.transaction(async trx=>{
                await trx('infinitepay_autorizacoes_producao').where({implantacao_id:config.databaseId}).whereNull('revogado_em').update({revogado_em:time()});
                await audit(trx,'EMERGENCY_STOP','ALLOW','ALL_CAPABILITIES_REVOKED',{userId:actor.id});return true;
            });
        });
    }
    return {approve,authorize,revoke,emergencyStop};
}
