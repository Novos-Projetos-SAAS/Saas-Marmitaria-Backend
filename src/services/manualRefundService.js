import {createHash} from 'node:crypto';
import {financialHttpError} from '../infinitepayRuntime.js';

const types={request:'ADMIN_ESTORNO_SOLICITADO',execute:'ADMIN_ESTORNO_EXECUCAO',reconcile:'ADMIN_ESTORNO_CONCILIACAO'};
const uuid=v=>typeof v==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const id=v=>Number.isSafeInteger(v) && v>0 && v<=2147483647;
const text=v=>typeof v==='string' && v.length>0 && v===v.trim() && !/[\p{Cc}\p{Cf}]/u.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const binding=p=>hash([p.id,p.pedido_id,p.order_nsu,p.transaction_nsu,p.invoice_slug,p.credencial_id,p.handle_snapshot,String(p.valor_centavos)]);
function proof(p,o,states) {
    return p?.provedor==='INFINITEPAY' && states.includes(p.status) && p.pago_em && p.provider_verified_at &&
        text(p.order_nsu) && text(p.transaction_nsu) && text(p.invoice_slug) && text(p.handle_snapshot) && p.credencial_id &&
        ['pix','credit_card'].includes(p.capture_method) && Number(p.valor_centavos)>0 &&
        Number(p.valor_base_provider_centavos)===Number(p.valor_centavos) && Number(p.valor_centavos)===Math.round(Number(o.valor_total)*100);
}
function body(input,keys) {
    if(!input || Array.isArray(input) || typeof input!=='object' || Object.keys(input).length!==keys.length ||
        Object.keys(input).some(k=>!keys.includes(k)) || !uuid(input.request_id))throw financialHttpError(400);
}

// An administrative report is not financial proof. These methods append audit
// records only; no provider call or payment/order/revenue update is available here.
export function createManualRefundService({db,now=()=>new Date()}) {
    async function actor(trx,actorId) {
        const found=await trx('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
            .join('permissoes_usuarios as pu','pu.usuario_id','u.id').join('permissoes as p','p.id','pu.permissao_id')
            .where({'u.id':actorId,'u.ativo':true,'n.ativo':true,'p.nome':'pagamentos.estornar'}).whereNull('u.deletado_em').select('u.id').forShare().first();
        if(!found)throw financialHttpError(403);
    }
    async function command(action,{pedidoId,estornoId,actorId,input}) {
        if(!id(pedidoId))throw financialHttpError(404);
        const keys=action==='request'?['request_id','motivo']:action==='execute'?['request_id','executado_em','referencia_sha256']:['request_id'];
        body(input,keys);
        if(action==='request' && !['SOLICITACAO_CLIENTE','ERRO_OPERACIONAL','OUTRO'].includes(input.motivo))throw financialHttpError(400);
        if(action!=='request' && !uuid(estornoId))throw financialHttpError(404);
        const instant=now();if(!(instant instanceof Date) || !Number.isFinite(instant.getTime()))throw financialHttpError(503);
        if(action==='execute' && (!/^[a-f0-9]{64}$/.test(input.referencia_sha256 || '') ||
            typeof input.executado_em!=='string' || !Number.isFinite(Date.parse(input.executado_em)) ||
            new Date(input.executado_em).toISOString()!==input.executado_em || new Date(input.executado_em)>instant))throw financialHttpError(400);
        const requestId=input.request_id.toLowerCase(),refundId=action==='request'?requestId:estornoId.toLowerCase();
        const key='admin_estorno:'+requestId,fingerprint=hash([action,pedidoId,refundId,...keys.map(k=>input[k])]);
        return db.transaction(async trx=>{
            await actor(trx,actorId);
            await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[key]);
            const old=await trx('pagamentos_eventos').where({event_key:key}).first();
            if(old) {
                const saved=old.payload_filtrado;
                if(old.tipo_evento!==types[action] || saved?.usuario_id!==actorId || saved.request_hash!==fingerprint)throw financialHttpError(409);
                return saved.resultado;
            }
            const order=await trx('pedidos').where({id:pedidoId}).whereNull('deletado_em').forUpdate().first();
            if(!order)throw financialHttpError(404);
            if(order.fluxo_pagamento!=='INFINITEPAY')throw financialHttpError(409);
            let root;
            if(action!=='request') {
                root=await trx('pagamentos_eventos').where({event_key:'admin_estorno:'+refundId,tipo_evento:types.request,status_processamento:'CONCLUIDO'}).first();
                if(root?.payload_filtrado?.pedido_id!==pedidoId)throw financialHttpError(404);
            }
            const payment=await trx('pagamentos').where({pedido_id:pedidoId})
                .modify(q=>{if(root)q.where({id:root.pagamento_id});}).orderBy('tentativa_numero','desc').forUpdate().first();
            if(!proof(payment,order,['PAGA','LIQUIDADA','ESTORNADA']))throw financialHttpError(409);
            if(root && root.payload_filtrado.vinculo_hash!==binding(payment))throw financialHttpError(409);
            const credential=await trx('infinitepay_credenciais').where({id:payment.credencial_id,handle:payment.handle_snapshot,config_id:1}).first('id');
            if(!credential)throw financialHttpError(409);
            let state='SOLICITADO',extra={};
            if(action==='request') {
                if(payment.status==='ESTORNADA' || await trx('pagamentos_eventos').where({pagamento_id:payment.id,tipo_evento:types.request}).first('id'))throw financialHttpError(409);
                extra={motivo:input.motivo,vinculo_hash:binding(payment)};
            }else {
                const execution=await trx('pagamentos_eventos').where({pagamento_id:payment.id,tipo_evento:types.execute})
                    .whereRaw("payload_filtrado->>'estorno_id' = ?",[refundId]).first();
                if(action==='execute') {
                    if(execution || new Date(input.executado_em)<new Date(payment.pago_em))throw financialHttpError(409);
                    state='EXECUCAO_EXTERNA_INFORMADA';extra={executado_em:input.executado_em,referencia_sha256:input.referencia_sha256};
                }else {
                    if(!execution)throw financialHttpError(409);
                    state='AGUARDANDO_PROVA_INDEPENDENTE';
                    if(payment.status==='ESTORNADA' && payment.estornado_em &&
                        new Date(payment.estornado_em)>=new Date(payment.pago_em) && new Date(payment.provider_verified_at)>=new Date(payment.estornado_em)) {
                        const event=await trx('pagamentos_eventos').where({pagamento_id:payment.id,tipo_evento:'refunded',status_processamento:'CONCLUIDO'})
                            .whereNotNull('processado_em').whereRaw("payload_filtrado->>'orderNsu' = ?",[payment.order_nsu])
                            .whereRaw("payload_filtrado->>'transactionNsu' = ?",[payment.transaction_nsu])
                            .whereRaw("payload_filtrado->>'invoiceSlug' = ?",[payment.invoice_slug]).first('id');
                        if(event){state='CONFIRMADO_POR_EVIDENCIA';extra={evento_comprobatorio_id:event.id};}
                    }
                }
            }
            const result={pedido_id:pedidoId,estorno_id:refundId,estado:state,valor_referencia_centavos:Number(payment.valor_centavos),
                confirmacao_financeira:state==='CONFIRMADO_POR_EVIDENCIA'};
            await trx('pagamentos_eventos').insert({pagamento_id:payment.id,event_key:key,tipo_evento:types[action],status_processamento:'CONCLUIDO',
                recebido_em:instant,processado_em:instant,payload_filtrado:{version:1,pedido_id:pedidoId,estorno_id:refundId,usuario_id:actorId,
                    request_hash:fingerprint,resultado:result,...extra}});
            return result;
        });
    }
    async function inspect({pedidoId,actorId}) {
        if(!id(pedidoId))throw financialHttpError(404);
        return db.transaction(async trx=>{
            await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await actor(trx,actorId);
            if(!await trx('pedidos').where({id:pedidoId}).whereNull('deletado_em').first('id'))throw financialHttpError(404);
            const root=await trx('pagamentos_eventos').where({tipo_evento:types.request}).whereRaw("payload_filtrado->>'pedido_id' = ?",[String(pedidoId)]).orderBy('id','desc').first();
            if(!root)return {pedido_id:pedidoId,estado:'SEM_SOLICITACAO',historico:[]};
            const rows=await trx('pagamentos_eventos').whereIn('tipo_evento',Object.values(types))
                .whereRaw("payload_filtrado->>'estorno_id' = ?",[root.payload_filtrado.estorno_id]).orderBy('id');
            return {...rows.at(-1).payload_filtrado.resultado,historico:rows.map(row=>({acao:row.tipo_evento,usuario_id:row.payload_filtrado.usuario_id,
                registrado_em:row.recebido_em,estado:row.payload_filtrado.resultado.estado,...(row.payload_filtrado.motivo?{motivo:row.payload_filtrado.motivo}:{}),
                ...(row.payload_filtrado.referencia_sha256?{referencia_sha256:row.payload_filtrado.referencia_sha256,executado_em:row.payload_filtrado.executado_em}:{})}))};
        });
    }
    return {request:input=>command('request',input),execute:input=>command('execute',input),reconcile:input=>command('reconcile',input),inspect};
}
