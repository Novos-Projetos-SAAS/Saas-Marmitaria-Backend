import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {createOperationalEnvelope,normalizeOperationalEnvelope} from '../services/operationalDestinationContract.js';

const table='infinitepay_destino_sintetico';
const blocked=()=>{throw new Error('Destino sintético indisponível.');};
function declaredScope(db) {
    const config=db?.client?.config;let {host,database}=config?.connection || {};
    if(config?.connection?.connectionString) {
        const url=new URL(config.connection.connectionString);
        if(!['postgres:','postgresql:'].includes(url.protocol) || url.search || url.hash)blocked();
        host=url.hostname;database=url.pathname.slice(1);
    }
    const schemas=config?.searchPath;
    if(!['127.0.0.1','localhost','::1','[::1]'].includes(host) || !/^infinitepay_[a-z0-9_]*test$/.test(database || '') ||
        !Array.isArray(schemas) || schemas.length!==1 || !/^iptest_[a-f0-9]{32}$/.test(schemas[0]))blocked();
    return {database,schema:schemas[0]};
}
export async function createSyntheticOrderDestination({db,secret,id='synthetic-order-destination',now=()=>new Date(),behavior='success'}={}) {
    if(!Buffer.isBuffer(secret) || secret.length!==32 || typeof now!=='function' || typeof id!=='string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id))blocked();
    const scope=declaredScope(db),key=Buffer.from(secret);let deployment;
    async function identity(reader=db) {
        declaredScope(db);
        const actual=(await reader.raw('SELECT current_database() AS name,current_schema() AS schema')).rows[0];
        if(actual.name!==scope.database || actual.schema!==scope.schema)blocked();
        if(deployment!==undefined && (await reader('infinitepay_identidade_ambiente').where({id:1}).first())?.identidade!==deployment)blocked();
    }
    await identity();
    if(!await db.schema.hasTable(table))blocked();
    deployment=(await db('infinitepay_identidade_ambiente').where({id:1}).first())?.identidade;
    if(typeof deployment!=='string')blocked();
    const envelope=dto=>createOperationalEnvelope(dto,{destination:id,deploymentId:deployment});
    const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const sign=(value,receiptId,instant)=>createHmac('sha256',key).update(JSON.stringify([value,receiptId,instant])).digest('hex');
    const mode=()=>typeof behavior==='function'?behavior():behavior;
    const abort=signal=>{if(signal?.aborted)blocked();};
    function receipt(row) {
        const value=normalizeOperationalEnvelope(row.envelope);
        return {acknowledged:true,key:value.idempotencyKey,pedidoId:value.payload.pedidoId,destination:id,receiptId:row.receipt_id,
            deliveryId:value.deliveryId,payloadHash:row.payload_hash,receivedAt:new Date(row.recebido_em).toISOString(),signature:row.assinatura,stage:'RECEIVED',printed:false};
    }
    async function lookup(dto,{signal}={}) {
        const value=envelope(dto);abort(signal);await identity();abort(signal);if(mode()==='unavailable')blocked();
        const row=await db(table).where({chave_unica:value.idempotencyKey}).first();
        abort(signal);if(!row)return null;
        if(row.destino!==id || row.payload_hash!==hash(value) || hash(normalizeOperationalEnvelope(row.envelope))!==hash(value))blocked();
        return receipt(row);
    }
    async function send(dto,{signal}={}) {
        const value=envelope(dto);abort(signal);await identity();abort(signal);
        const scenario=mode();if(!['success','before_receipt','unavailable','timeout_after_receipt','missing_receipt','invalid_receipt','duplicate_receipt'].includes(scenario))blocked();
        if(['before_receipt','unavailable'].includes(scenario))blocked();
        const row=await db.transaction(async trx=>{
            await identity(trx);abort(signal);await trx.raw('SET LOCAL synchronous_commit=on');
            const instant=now();if(!(instant instanceof Date) || !Number.isFinite(instant.getTime()))blocked();
            const receiptId=randomUUID();
            await trx(table).insert({chave_unica:value.idempotencyKey,destino:id,envelope:value,payload_hash:hash(value),receipt_id:receiptId,
                recebido_em:instant,assinatura:sign(value,receiptId,instant.toISOString())}).onConflict('chave_unica').ignore();
            const saved=await trx(table).where({chave_unica:value.idempotencyKey}).first();
            if(saved.destino!==id || saved.payload_hash!==hash(value) || hash(normalizeOperationalEnvelope(saved.envelope))!==hash(value))blocked();
            return saved;
        });
        if(scenario==='timeout_after_receipt')await new Promise((_,reject)=>{
            const fail=()=>{clearTimeout(timer);signal?.removeEventListener('abort',fail);reject(new Error('Resposta sintética perdida após recebimento.'));};
            const timer=setTimeout(fail,250);signal?.addEventListener('abort',fail,{once:true});if(signal?.aborted)fail();
        });
        if(scenario==='missing_receipt')return undefined;
        const answer=receipt(row);
        if(scenario==='invalid_receipt')return {...answer,receiptId:randomUUID()};
        return answer;
    }
    async function verifyReceipt(candidate,dto,options={}) {
        try {
            if(!candidate || ![Object.prototype,null].includes(Object.getPrototypeOf(candidate)) || candidate.acknowledged!==true ||
                candidate.stage!=='RECEIVED' || candidate.printed!==false ||
                !(typeof candidate.pedidoId==='string' && /^[1-9]\d{0,18}$/.test(candidate.pedidoId) || typeof candidate.pedidoId==='number' && Number.isSafeInteger(candidate.pedidoId) && candidate.pedidoId>0) ||
                typeof candidate.signature!=='string' || !/^[a-f0-9]{64}$/.test(candidate.signature))return false;
            const stored=await lookup(dto,options);if(!stored || JSON.stringify(Object.keys(candidate).sort())!==JSON.stringify(Object.keys(stored).sort()))return false;
            for(const field of Object.keys(stored))if(field==='pedidoId' ? String(candidate[field])!==String(stored[field]) : candidate[field]!==stored[field])return false;
            const expected=sign(envelope(dto),candidate.receiptId,candidate.receivedAt);
            return timingSafeEqual(Buffer.from(candidate.signature,'hex'),Buffer.from(expected,'hex'));
        } catch {return false;}
    }
    return Object.freeze({id,supportsIdempotency:true,send,lookupReceipt:lookup,verifyReceipt});
}
