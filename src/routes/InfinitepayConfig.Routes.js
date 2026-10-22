import { Router } from 'express';
import { verifyToken } from '../middlewares/verifyToken.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { requireActiveFinancialUser, protectInfinitepayWrite } from '../middlewares/infinitepayAdminSecurity.js';
import { buscarInfinitepayConfig, salvarInfinitepayConfig } from '../controllers/InfinitepayConfig.Controller.js';
const router = Router();
router.use((req, res, next) => {
    res.set('Cache-Control','no-store');
    res.set('Referrer-Policy','no-referrer');
    next();
});
router.use(verifyToken, requireActiveFinancialUser, checkPermission('pagamentos.configurar'));
router.get('/', buscarInfinitepayConfig);
router.put('/', protectInfinitepayWrite, salvarInfinitepayConfig);
export default router;
