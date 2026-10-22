import { getInfinitepayConfig, updateInfinitepayConfig } from '../services/infinitepayConfigService.js';
import { csrfToken } from '../middlewares/infinitepayAdminSecurity.js';
export async function buscarInfinitepayConfig(req, res, next) {
    try { res.json({ status: 'success', data: await getInfinitepayConfig(), csrf_token: csrfToken(req) }); }
    catch (error) { next(error); }
}
export async function salvarInfinitepayConfig(req, res, next) {
    try { res.json({ status: 'success', data: await updateInfinitepayConfig(req.body, req.usuario) }); }
    catch (error) { next(error); }
}
