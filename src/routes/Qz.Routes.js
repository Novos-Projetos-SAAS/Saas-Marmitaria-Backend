import { Router } from 'express';
import { assinarRequisicaoQZ } from '../controllers/Qz.Controller.js';
import { qzSecureRuntimeAvailable } from '../services/qzSecureSigning.js';

export function createQzRoutes({mode=()=>process.env.QZ_SIGNING_MODE,legacySign=assinarRequisicaoQZ}={}) {
    const qzRoutes=Router();let protectedSelected=false;
    qzRoutes.use((req,res,next)=>{
        let value;try{value=mode();}catch{return res.status(503).json({code:'QZ_UNAVAILABLE'});}
        const runtime=req.app.locals.qzSecureSigning;
        if(qzSecureRuntimeAvailable(runtime))protectedSelected=true;
        if((value===undefined || value==='legacy') && !protectedSelected)return next();
        protectedSelected=true;
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        if(value!=='secure-test' || !qzSecureRuntimeAvailable(runtime))return res.status(503).json({code:'QZ_UNAVAILABLE'});
        // Never next() into the anonymous handler when the protected mode is selected.
        return runtime.router(req,res,()=>res.status(404).json({code:'QZ_ROUTE_NOT_AVAILABLE'}));
    });
    qzRoutes.post('/assinar',legacySign);
    return qzRoutes;
}

export default createQzRoutes();
