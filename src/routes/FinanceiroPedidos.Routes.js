import { Router } from 'express';
import connection from '../database/connection.js';
import { verifyToken } from '../middlewares/verifyToken.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { requireActiveFinancialUser } from '../middlewares/infinitepayAdminSecurity.js';
import { aplicarElegibilidadeOperacional } from '../utils/pedidoPaymentPolicy.js';
import { validatedReceipt } from '../services/checkoutSessionService.js';
import { financialHttpError } from '../infinitepayRuntime.js';

const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
router.use(verifyToken, requireActiveFinancialUser, checkPermission('pagamentos.visualizar'));
router.get('/', async (req, res) => {
    const rows = await connection('pedidos').where({ fluxo_pagamento: 'INFINITEPAY' }).whereNull('deletado_em')
        .select('pedidos.id as pedido_id', 'nome_cliente', 'valor_total', 'status as pedido_status', 'criado_em')
        .select(connection.raw(`(SELECT status FROM pagamentos WHERE pedido_id=pedidos.id ORDER BY tentativa_numero DESC LIMIT 1) AS pagamento_status`))
        .orderBy('pedidos.id', 'desc').limit(100);
    const eligible = new Set((await aplicarElegibilidadeOperacional(connection('pedidos')).whereIn('pedidos.id', rows.map(row => row.pedido_id)).select('pedidos.id')).map(row => row.id));
    const payments = await connection('pagamentos').whereIn('pedido_id', rows.map(row => row.pedido_id)).orderBy('tentativa_numero', 'desc');
    res.json({ status: 'success', data: rows.map(row => ({ ...row, cozinha_autorizada: eligible.has(row.pedido_id),
        comprovante_disponivel: eligible.has(row.pedido_id) && Boolean(validatedReceipt(payments.find(payment => payment.pedido_id === row.pedido_id))) })) });
});
router.get('/:id/comprovante', async (req, res) => {
    if (!/^[1-9]\d{0,9}$/.test(req.params.id) || Number(req.params.id) > 2147483647) throw financialHttpError(404);
    const eligible = await aplicarElegibilidadeOperacional(connection('pedidos')).where('pedidos.id', Number(req.params.id)).whereNull('pedidos.deletado_em').first('pedidos.id');
    const payment = eligible && await connection('pagamentos').where({ pedido_id: eligible.id }).orderBy('tentativa_numero', 'desc').first();
    const url = validatedReceipt(payment);
    if (!url) throw financialHttpError(404);
    res.json({ status: 'success', data: { receipt_url: url } });
});
export default router;
