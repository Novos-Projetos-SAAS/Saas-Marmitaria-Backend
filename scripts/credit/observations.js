import { createHash } from 'node:crypto';
import { encryptH1Observation, decryptH1Observation } from '../../src/homologation/infinitepayH1.js';

// Reuse the existing authenticated observation envelope with a separate Credit key/database.
export const sealObservation=encryptH1Observation;
export const openObservation=decryptH1Observation;
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function readCreditBody(response) {
    const reader=response.body?.getReader();if(!reader)throw new Error('Resposta indisponível.');
    const chunks=[];let bytes=0;
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;
        if(bytes>32768){await reader.cancel();throw new Error('Resposta excede limite.');}chunks.push(Buffer.from(part.value));}
    return Buffer.concat(chunks).toString('utf8');
}
export async function observeCredit(db,key,kind,value,paymentId=null) {
    const text=JSON.stringify(value);
    if(Buffer.byteLength(text)>65536)throw new Error('Observação H4 excede limite.');
    const [row]=await db('pagamentos_eventos').insert({event_key:'h4:observation:'+kind+':'+digest(text),tipo_evento:'H4_OBSERVACAO_'+kind,
        pagamento_id:paymentId,payload_filtrado:sealObservation(value,key),status_processamento:'PENDENTE_IDENTIFICACAO'})
        .onConflict('event_key').ignore().returning('id');
    return row?.id;
}
export function observationHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).filter(([name])=>!['authorization','cookie','x-api-key'].includes(name.toLowerCase()))
        .slice(0,40).map(([name,value])=>[name,String(value).slice(0,1024)]));
}
