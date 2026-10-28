import {createHash} from 'node:crypto';

const invalid=()=>{throw new Error('Contrato de entrega operacional inválido.');};
function exact(value,keys) {
    if(!value || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).length!==keys.length || Object.keys(value).some(k=>!keys.includes(k)))invalid();
}
const positive=value=>typeof value==='number' && Number.isSafeInteger(value) && value>0 ||
    typeof value==='string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export function createOperationalEnvelope(dto,{destination,deploymentId}={}) {
    exact(dto,['id','pedidoId','tipo','key']);
    if(!positive(dto.id) || !positive(dto.pedidoId) || dto.tipo!=='PEDIDO_LIBERADO' || typeof dto.key!=='string' ||
        !dto.key || dto.key!==dto.key.trim() || dto.key.length>255 || /[\p{Cc}\p{Cf}]/u.test(dto.key) ||
        typeof destination!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(destination) || !uuid(deploymentId))invalid();
    const deployment=deploymentId.toLowerCase();
    return Object.freeze({version:1,deliveryId:createHash('sha256').update(JSON.stringify([deployment,dto.key])).digest('hex'),
        idempotencyKey:dto.key,deploymentId:deployment,outboxId:String(dto.id),recipient:Object.freeze({id:destination}),
        payload:Object.freeze({pedidoId:String(dto.pedidoId),tipo:'PEDIDO_LIBERADO'})});
}
export function normalizeOperationalEnvelope(value) {
    exact(value,['version','deliveryId','idempotencyKey','deploymentId','outboxId','recipient','payload']);
    exact(value.recipient,['id']);exact(value.payload,['pedidoId','tipo']);
    const normalized=createOperationalEnvelope({id:value.outboxId,pedidoId:value.payload.pedidoId,tipo:value.payload.tipo,key:value.idempotencyKey},
        {destination:value.recipient.id,deploymentId:value.deploymentId});
    if(value.version!==1 || value.deliveryId!==normalized.deliveryId || value.deploymentId!==normalized.deploymentId ||
        value.outboxId!==normalized.outboxId || value.payload.pedidoId!==normalized.payload.pedidoId)invalid();
    return normalized;
}
