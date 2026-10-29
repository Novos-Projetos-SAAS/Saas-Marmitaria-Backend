import { Router } from 'express';
import { qzSecureRuntimeAvailable } from '../services/qzSecureSigning.js';

export function createQzRoutes({mode=()=>process.env.QZ_SIGNING_MODE,environment=()=>process.env.NODE_ENV}={}) {
    const qzRoutes=Router();
    qzRoutes.use((req,res,next)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        let value,profile;try{value=mode();profile=environment();}catch{return res.status(503).json({code:'QZ_UNAVAILABLE'});}
        // This candidate has no operational signer. Public/default deployments
        // must never mount legacy signing, even when a private key is present.
        if(profile!=='test' || value!=='secure-test')return res.status(503).json({code:'QZ_DISABLED'});
        const runtime=req.app.locals.qzSecureSigning;
        if(!qzSecureRuntimeAvailable(runtime))return res.status(503).json({code:'QZ_UNAVAILABLE'});
        return runtime.router(req,res,()=>res.status(404).json({code:'QZ_ROUTE_NOT_AVAILABLE'}));
    });
    return qzRoutes;
}

export default createQzRoutes();
