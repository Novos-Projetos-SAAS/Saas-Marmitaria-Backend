import { Router } from 'express';
import connection from '../database/connection.js';
import { verifyToken } from '../middlewares/verifyToken.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { requireActiveFinancialUser, protectInfinitepayWrite, csrfToken } from '../middlewares/infinitepayAdminSecurity.js';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';
import { validatedReceipt, availableReceiptOrders } from '../services/checkoutSessionService.js';
import { financialHttpError } from '../infinitepayRuntime.js';
import { createAdministrativePaymentReconciliation } from '../services/administrativePaymentReconciliation.js';
import { createManualRefundService } from '../services/manualRefundService.js';

const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
router.use(verifyToken, requireActiveFinancialUser);
router.get('/csrf',checkPermission('pagamentos.visualizar'),(req,res)=>{
    if(!req.secure)throw financialHttpError(403);
    res.json({status:'success',csrf_token:csrfToken(req)});
});
function httpsOrigin(req,res,next) {
    if(!req.secure)throw financialHttpError(403);
    let origin;
    try{origin=new URL(req.get('Origin'));}catch{throw financialHttpError(403);}
    if(origin.protocol!=='https:' || origin.origin!==req.get('Origin'))throw financialHttpError(403);
    next();
}
router.post('/:id/conciliar',httpsOrigin,protectInfinitepayWrite,async(req,res)=>{
    if(!/^[1-9]\d{0,9}$/.test(req.params.id))throw financialHttpError(404);
    const service=createAdministrativePaymentReconciliation({db:connection});
    const data=await service.request({pedidoId:Number(req.params.id),actorId:req.usuario.id,input:req.body});
    res.json({status:'success',data});
});
router.get('/:id/estornos',async(req,res)=>{
    if(!req.secure || !/^[1-9]\d{0,9}$/.test(req.params.id))throw financialHttpError(403);
    const data=await createManualRefundService({db:connection}).inspect({pedidoId:Number(req.params.id),actorId:req.usuario.id});
    res.json({status:'success',data});
});
for(const [path,action] of [['/:id/estornos','request'],['/:id/estornos/:estornoId/execucao','execute'],['/:id/estornos/:estornoId/conciliar','reconcile']]) {
    router.post(path,httpsOrigin,protectInfinitepayWrite,async(req,res)=>{
        if(!/^[1-9]\d{0,9}$/.test(req.params.id))throw financialHttpError(404);
        const data=await createManualRefundService({db:connection})[action]({pedidoId:Number(req.params.id),estornoId:req.params.estornoId,actorId:req.usuario.id,input:req.body});
        res.json({status:'success',data});
    });
}
router.get('/',checkPermission('pagamentos.visualizar'), async (req, res) => {
    const rows = await connection('pedidos').where({ fluxo_pagamento: 'INFINITEPAY' }).whereNull('deletado_em')
        .select('pedidos.id as pedido_id', 'nome_cliente', 'valor_total', 'status as pedido_status', 'criado_em')
        .select(connection.raw(`(SELECT status FROM pagamentos WHERE pedido_id=pedidos.id ORDER BY tentativa_numero DESC LIMIT 1) AS pagamento_status`))
        .orderBy('pedidos.id', 'desc').limit(100);
    const eligible = new Set((await aplicarElegibilidadeOperacional(connection('pedidos')).whereIn('pedidos.id', rows.map(row => row.pedido_id)).select('pedidos.id')).map(row => row.id));
    const receipts = await availableReceiptOrders(connection, rows.map(row => row.pedido_id));
    res.json({ status: 'success', data: rows.map(row => ({ ...row, cozinha_autorizada: eligible.has(row.pedido_id),
        comprovante_disponivel: receipts.has(row.pedido_id) })) });
});
router.get('/:id/comprovante',checkPermission('pagamentos.visualizar'), async (req, res) => {
    if (!/^[1-9]\d{0,9}$/.test(req.params.id) || Number(req.params.id) > 2147483647) throw financialHttpError(404);
    const eligible = await aplicarElegibilidadeOperacional(connection('pedidos')).where('pedidos.id', Number(req.params.id)).whereNull('pedidos.deletado_em').first('pedidos.id');
    const payment = eligible && await connection('pagamentos').where({ pedido_id: eligible.id }).orderBy('tentativa_numero', 'desc').first();
    const url = validatedReceipt(payment);
    if (!url) throw financialHttpError(404);
    res.json({ status: 'success', data: { receipt_url: url } });
});
export default router;
