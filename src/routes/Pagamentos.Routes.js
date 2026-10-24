import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { financialHttpError } from '../infinitepayRuntime.js';

const router = Router();
router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (!req.app.locals.infinitepayRuntime) return next(financialHttpError(503));
    next();
});
router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false,
    message: { status: 'fail', message: 'Aguarde antes de tentar novamente.' } }));
const runtime = req => req.app.locals.infinitepayRuntime;
function jsonOnly(req, res, next) {
    if (!req.is('application/json')) return next(financialHttpError(415));
    next();
}
function bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') || '');
    return match?.[1];
}
router.get('/consulta', async (req, res) => {
    const pedidoId = await runtime(req).authorize(req.query.ref, 'STATUS');
    res.json({ status: 'success', data: await runtime(req).status(pedidoId) });
});
router.post('/retomar', jsonOnly, async (req, res) => {
    const pedidoId = await runtime(req).authorize(bearer(req), 'TITULAR');
    res.json({ status: 'success', data: await runtime(req).resume(pedidoId, req.body) });
});
router.post('/infinitepay/webhook', jsonOnly, async (req, res) => {
    await runtime(req).receiveEvent(req.body);
    // Acknowledges durable receipt only; payment confirmation runs independently.
    res.status(200).json({ status: 'accepted' });
});
router.get('/infinitepay/retorno', async (req, res) => {
    res.redirect(303, await runtime(req).receiveReturn(req.query));
});
export default router;
