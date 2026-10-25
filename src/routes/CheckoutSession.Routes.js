import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import connection from '../database/connection.js';
import { createCheckoutSessionService } from '../services/checkoutSessionService.js';
import { criarPedido } from '../controllers/Pedidos.Controller.js';
import { financialHttpError } from '../infinitepayRuntime.js';

const router = Router();
router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next();
});
router.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }));
const token = req => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') || '')?.[1];
const service = req => req.app.locals.checkoutSessions ?? createCheckoutSessionService({ db: connection, runtime: () => req.app.locals.infinitepayRuntime });
function jsonOnly(req, res, next) {
    if (!req.is('application/json')) return next(financialHttpError(415)); next();
}
async function ownedWrite(req, res, next) {
    await service(req).authorize(token(req), req.get('X-Checkout-CSRF') || ''); next();
}
router.post('/', jsonOnly, async (req, res) => {
    res.json({ status: 'success', data: await service(req).open(token(req)) });
});
router.get('/pedido', async (req, res) => res.json({ status: 'success', data: await service(req).lookup(token(req), req.query.requisicao) }));
router.get('/retorno', async (req, res) => res.json({ status: 'success', data: await service(req).lookupStatus(token(req), req.query.ref) }));
router.post('/pedido', jsonOnly, ownedWrite, (req, res, next) => {
    res.locals.origemPedido = 'PUBLICO';
    res.locals.checkoutSession = { token: token(req), service: service(req) }; next();
}, criarPedido);
router.post('/retomar', jsonOnly, ownedWrite, async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => key !== 'client_request_id')) throw financialHttpError(400);
    res.json({ status: 'success', data: await service(req).resume(token(req), req.body.client_request_id) });
});
router.post('/nova-compra', jsonOnly, ownedWrite, async (req, res) => {
    if (!req.body || Object.keys(req.body).length) throw financialHttpError(400);
    res.json({ status: 'success', data: await service(req).newRequest(token(req)) });
});
export default router;
