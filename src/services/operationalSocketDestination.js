import {createHash} from 'node:crypto';
import {aplicarElegibilidadeOperacional} from '../utils/pedidoPaymentPolicy.js';

// The destination is the existing PostgreSQL operational list. Socket.IO is a
// best-effort notification; this receipt never attests browser receipt or print.
export function createOperationalSocketDestination({db,io,loadOrder,deploymentId}) {
    if(typeof db!=='function' || typeof io?.to!=='function' || typeof loadOrder!=='function' ||
        typeof deploymentId!=='string' || !/^[A-Za-z0-9-]{1,50}$/.test(deploymentId))throw new TypeError('Destino operacional inválido.');
    const id='admin-orders:'+deploymentId;
    const unavailable=()=>{throw Object.assign(new Error('Pedido operacional indisponível.'),{code:'ORDER_DESTINATION_UNAVAILABLE'});};
    async function available(dto,{signal}={}) {
        if(signal?.aborted || dto?.tipo!=='PEDIDO_LIBERADO')unavailable();
        const event=await db('outbox_eventos').where({id:dto.id,pedido_id:dto.pedidoId,tipo:dto.tipo,chave_unica:dto.key}).first('id');
        const order=event && await aplicarElegibilidadeOperacional(db('pedidos'),{confirmedStates:['PAGA','LIQUIDADA']})
            .where({'pedidos.id':dto.pedidoId,'pedidos.fluxo_pagamento':'INFINITEPAY'}).whereNull('pedidos.deletado_em')
            .first('pedidos.id','pedidos.liberado_cozinha_em');
        if(!order || signal?.aborted)unavailable();
        const digest=createHash('sha256').update(JSON.stringify([id,String(dto.id),String(order.id),dto.key,
            new Date(order.liberado_cozinha_em).toISOString()])).digest('hex');
        return {acknowledged:true,key:dto.key,pedidoId:order.id,destination:id,receiptId:'available:'+digest};
    }
    return {id,supportsIdempotency:true,
        async send(dto,options) {
            const receipt=await available(dto,options),order=await loadOrder(dto.pedidoId);
            if(String(order?.id)!==String(dto.pedidoId) || order.cozinha_autorizada!==true || options?.signal?.aborted)unavailable();
            await available(dto,options);
            try{io.to('pedidos').emit('novo_pedido_recebido',order);}catch{/* The persisted list remains available after a socket failure. */}
            return receipt;
        },
        lookupReceipt:available,
        async verifyReceipt(receipt,dto,options) {
            try {
                const expected=await available(dto,options);
                return receipt?.acknowledged===true && receipt.key===expected.key && String(receipt.pedidoId)===String(expected.pedidoId) &&
                    receipt.destination===expected.destination && receipt.receiptId===expected.receiptId;
            }catch{return false;}
        }
    };
}
