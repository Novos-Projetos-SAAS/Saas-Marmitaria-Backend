import { Router } from 'express';
import { verifyToken } from '../middlewares/verifyToken.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { csrfToken, requireActiveFinancialUser, protectInfinitepayWrite } from '../middlewares/infinitepayAdminSecurity.js';
import { readPublicConfig, updateInfinitepayConfig, setInfinitepayActivation } from '../services/infinitepayConfigService.js';

const router = Router();
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    // The shared error handler records req.body; retain credentials only outside that logged object.
    res.locals.infinitepayInput = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
    if (req.body && typeof req.body === 'object' && Object.hasOwn(req.body, 'api_key')) {
        req.body = { ...req.body, api_key: '[REDACTED]' };
    }
    next();
});
router.use(verifyToken, requireActiveFinancialUser);
router.get('/', checkPermission(['pagamentos.configurar', 'pagamentos.ativar', 'pagamentos.visualizar']), async (req, res, next) => {
    try { res.json({ status: 'success', data: await readPublicConfig(), csrf_token: csrfToken(req) }); }
    catch (error) { next(error); }
});
router.put('/', checkPermission('pagamentos.configurar'), protectInfinitepayWrite, async (req, res, next) => {
    try {
        const data = await updateInfinitepayConfig(res.locals.infinitepayInput);
        res.json({ status: 'success', data, csrf_token: csrfToken(req) });
    } catch (error) { next(error); }
});
router.patch('/ativacao', checkPermission('pagamentos.ativar'), protectInfinitepayWrite, async (req, res, next) => {
    try {
        const data = await setInfinitepayActivation(res.locals.infinitepayInput);
        res.json({ status: 'success', data, csrf_token: csrfToken(req) });
    } catch (error) { next(error); }
});
export default router;
