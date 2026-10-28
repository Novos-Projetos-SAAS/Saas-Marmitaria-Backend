import {Router,json} from 'express';

// Deliberately not imported or mounted by app/server. Installation requires a separate, reviewed composition.
export function createProductionControlRouter({authorizer}={}) {
    if(['approve','status','revoke','emergencyStop','csrf','endSession','recover'].some(method=>typeof authorizer?.[method]!=='function'))throw new TypeError('Controle administrativo indisponível.');
    const router=Router();
    router.use((req,res,next)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        if(!req.secure)return res.status(403).json({status:'fail',code:'ADMINISTRATION_DENIED'});
        next();
    });
    router.use((req,res,next)=>{
        if(req.method==='POST' && !req.is('application/json'))return res.status(415).json({status:'fail',code:'JSON_REQUIRED'});
        next();
    },json({limit:'8kb',strict:true}));
    const session=req=>({token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')});
    const body=(req,keys)=>{
        if(!req.body || Array.isArray(req.body) || typeof req.body!=='object' || Object.keys(req.body).some(key=>!keys.includes(key))) {
            const error=new Error();error.code='INVALID_BODY';throw error;
        }
        return req.body;
    };
    router.get('/',async(req,res)=>res.json({status:'success',data:await authorizer.status({session:session(req)})}));
    router.get('/csrf',async(req,res)=>res.json({status:'success',data:await authorizer.csrf({session:session(req)})}));
    router.post('/approvals',async(req,res)=>{
        const data=await authorizer.approve({...body(req,['capabilities','validForSeconds','credentialId','destinationId']),session:session(req)});
        res.status(201).json({status:'success',data});
    });
    router.post('/revocations',async(req,res)=>{
        const revoked=await authorizer.revoke({...body(req,['id']),session:session(req)});
        res.json({status:'success',data:{revoked}});
    });
    router.post('/emergency-stop',async(req,res)=>{
        body(req,[]);await authorizer.emergencyStop({session:session(req)});
        res.json({status:'success',data:{halted:true}});
    });
    router.post('/session/end',async(req,res)=>{
        body(req,[]);res.json({status:'success',data:await authorizer.endSession({session:session(req)})});
    });
    router.post('/recovery',async(req,res)=>{
        const data=await authorizer.recover({...body(req,['expectedGeneration','confirmation']),session:session(req)});
        res.json({status:'success',data});
    });
    router.use((error,req,res,next)=>{
        if(res.headersSent)return next(error);
        const invalid=error.code==='INVALID_BODY' || error.type==='entity.parse.failed';
        const denied=['ADMINISTRATION_DENIED','INVALID_REQUEST','INVALID_CAPABILITIES','INVALID_DESTINATION','CREDENTIAL_INVALID',
            'HISTORICAL_CREDENTIAL_SCOPE','SESSION_EXPIRED','EMERGENCY_STOP'].includes(error.code);
        const status=invalid?400:error.type==='entity.too.large'?413:denied?403:503;
        const pending=['STOP_PERSISTED_AUDIT_PENDING','SESSION_ENDED_AUDIT_PENDING','REVOCATION_PERSISTED_AUDIT_PENDING'].includes(error.code);
        res.status(status).json({status:'fail',code:pending?error.code:invalid?'INVALID_REQUEST':status===413?'REQUEST_TOO_LARGE':denied?'ADMINISTRATION_DENIED':'CONTROL_UNAVAILABLE'});
    });
    return router;
}
