import { getInfinitepayConfig, updateInfinitepayConfig } from '../services/infinitepayConfigService.js';
import { csrfToken } from '../middlewares/infinitepayAdminSecurity.js';
export async function buscarInfinitepayConfig(req, res, next) {
    try {
        const data=await getInfinitepayConfig();
        let activationAvailable=false;
        if(req.app.locals.infinitepayActivation) {
            try { activationAvailable=await req.app.locals.infinitepayActivation.assertReady() === true; } catch {}
        }
        res.json({ status:'success',data,csrf_token:csrfToken(req),activation_available:activationAvailable,
            ...(req.app.locals.infinitepayActivation ? {processing:req.app.locals.infinitepayActivation.status()} : {}) });
    }
    catch (error) { next(error); }
}
export async function salvarInfinitepayConfig(req, res, next) {
    try { res.json({ status: 'success', data: await updateInfinitepayConfig(req.body, req.usuario, req.app.locals.infinitepayActivation) }); }
    catch (error) { next(error); }
}
