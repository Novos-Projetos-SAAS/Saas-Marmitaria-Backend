// Explicit composition only. Do not install on general logout without a compatible session/CSRF dispatcher.
export function createProductionLogoutBridge({authorizer,logout}) {
    if(typeof authorizer?.endSession!=='function' || typeof logout!=='function')throw new TypeError('Encerramento administrativo indisponível.');
    return async(req,res,next)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        if(!req.secure)return res.status(403).json({status:'fail',code:'ADMINISTRATION_DENIED'});
        try {
            const result=await authorizer.endSession({session:{token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')}});
            if(result?.ended!==true)throw new Error('Encerramento não confirmado.');
            return logout(req,res,next);
        }catch(error){
            const denied=error.code==='ADMINISTRATION_DENIED';
            return res.status(denied?403:503).json({status:'fail',code:denied?'ADMINISTRATION_DENIED':
                error.code==='SESSION_ENDED_AUDIT_PENDING'?'SESSION_ENDED_AUDIT_PENDING':'SESSION_END_UNAVAILABLE'});
        }
    };
}
