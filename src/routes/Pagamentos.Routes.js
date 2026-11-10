import { Router } from 'express';
import { limitadorPagamentoPublico } from '../middlewares/rateLimiter.js';
import { criarPedido } from '../controllers/Pedidos.Controller.js';
import { verifyToken } from '../middlewares/verifyToken.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { csrfToken, protectInfinitepayWrite, requireActiveFinancialUser } from '../middlewares/infinitepayAdminSecurity.js';
import { adminPayments, confirmPayment, ownedPayment, paymentError, reconcileOrder } from '../services/infinitepayPaymentService.js';

const router = Router();
const asyncRoute = action => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { await action(req, res); } catch (error) { next(error); }
};
const orderId = req => {
    const value = Number(req.params.id);
    if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw paymentError('Pedido inválido.', 400);
    return value;
};
const token = req => {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw paymentError('Acesso ao pedido indisponível.', 404);
    return header.slice(7);
};

router.post('/checkout', limitadorPagamentoPublico, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    return criarPedido(req, res, next);
});

router.get('/pedidos/:id', limitadorPagamentoPublico, asyncRoute(async (req, res) => {
    res.json({ status: 'success', data: await ownedPayment(orderId(req), token(req)) });
}));
router.post('/pedidos/:id/confirmar', limitadorPagamentoPublico, asyncRoute(async (req, res) => {
    const pedido = await ownedPayment(orderId(req), token(req));
    if (req.body?.order_nsu && req.body.order_nsu !== pedido.order_nsu) throw paymentError('Cobrança não pertence ao pedido.', 400);
    await confirmPayment(pedido.order_nsu, req.body || {});
    res.json({ status: 'success', data: await ownedPayment(orderId(req), token(req)) });
}));

const webhook = asyncRoute(async (req, res) => {
    await confirmPayment(req.body?.order_nsu, req.body || {});
    res.json({ status: 'success' });
});
router.post('/webhook/infinitepay', webhook);
// Existing links retain their original webhook URL after migration.
router.post('/infinitepay/webhook', webhook);
router.get('/infinitepay/retorno', asyncRoute(async (req, res) => {
    await confirmPayment(req.query.order_nsu, req.query);
    const origin = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim())
        .find(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } });
    if (!origin) throw paymentError('Origem de retorno indisponível.', 503);
    res.redirect(303, new URL('/pedido/sucesso', origin).href);
}));

router.use(verifyToken, requireActiveFinancialUser);
router.get('/admin', checkPermission(['pagamentos.visualizar', 'pagamentos.conciliar']), asyncRoute(async (req, res) => {
    res.json({ status: 'success', data: await adminPayments(req.query), csrf_token: csrfToken(req) });
}));
router.post('/admin/:id/conciliar', checkPermission('pagamentos.conciliar'), protectInfinitepayWrite, asyncRoute(async (req, res) => {
    res.json({ status: 'success', data: await reconcileOrder(orderId(req), req.body || {}) });
}));

// Keep the former provider callback path functional without reinstating its workers.
export const legacyInfinitepayWebhook = webhook;
export default router;
