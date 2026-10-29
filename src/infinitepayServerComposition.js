import {createHash} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {initializeInfinitepayApplication,validateInfinitepayEnvironment} from './infinitepayApplication.js';
import {createProductionAuthorizer} from './services/productionAuthorizer.js';
import {createOperationalSocketDestination} from './services/operationalSocketDestination.js';
import {createProductionControlRouter} from './routes/InfinitepayProductionControl.Routes.js';
import {createProductionDiagnostics} from './services/productionDiagnostics.js';
import {createProductionLogoutBridge} from './middlewares/productionLogoutBridge.js';
import {logout} from './utils/logoutResponse.js';

export async function initializeServerFinancial({app,db,io,loadOrder,env=process.env,now=()=>new Date(),transport=globalThis.fetch}) {
    const config=validateInfinitepayEnvironment(env);
    if(config?.mode!=='production')return initializeInfinitepayApplication({app,db,env,now,transport});
    const authorizer=createProductionAuthorizer({db,env,now,sessionSecret:()=>env.JWT_SECRET});
    const destination=createOperationalSocketDestination({db,io,loadOrder,deploymentId:config.databaseId});
    const application=await initializeInfinitepayApplication({app,db,env,now,transport,
        productionAuthorization:authorizer.authorize,operationalAdapter:destination});
    const diagnostics=createProductionDiagnostics({db,authorizer,application,now});
    const control=createProductionControlRouter({authorizer});
    control.get('/session/logout-csrf',async(req,res)=>{
        try{return res.json({status:'success',data:await authorizer.logoutCsrf({session:{token:req.cookies?.token,origin:req.get('Origin')}})});}
        catch{return res.status(403).json({status:'fail',code:'ADMINISTRATION_DENIED'});}
    });
    control.get('/diagnostico',async(req,res)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        if(!req.secure)return res.status(403).json({status:'fail',code:'ADMINISTRATION_DENIED'});
        try {
            const data=await diagnostics.read({session:{token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')}});
            return res.json({status:'success',data});
        }catch(error){return res.status(error.statusCode || 503).json({status:'fail',code:error.code || 'DIAGNOSTICS_UNAVAILABLE'});}
    });
    for(const action of ['start','stop'])control.post('/worker/'+action,async(req,res)=>{
        try {
            await authorizer.status({session:{token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')}});
            if(!req.body || Array.isArray(req.body) || Object.keys(req.body).length)return res.status(400).json({status:'fail',code:'INVALID_REQUEST'});
            await application[action]();
            return res.json({status:'success',data:application.status()});
        }catch(error){return res.status(error.code==='ADMINISTRATION_DENIED'?403:503).json({status:'fail',code:error.code==='ADMINISTRATION_DENIED'?'ADMINISTRATION_DENIED':'WORKER_UNAVAILABLE'});}
    });
    control.post('/entregas/:id/recuperar',async(req,res)=>{
        try {
            await authorizer.status({session:{token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')}});
            if(!req.body || Array.isArray(req.body) || Object.keys(req.body).length)return res.status(400).json({status:'fail',code:'INVALID_REQUEST'});
            return res.json({status:'success',data:await application.recoverDelivery(req.params.id)});
        }catch(error){return res.status(error.code==='ADMINISTRATION_DENIED'?403:503).json({status:'fail',code:error.code==='ADMINISTRATION_DENIED'?'ADMINISTRATION_DENIED':'DELIVERY_RECOVERY_UNAVAILABLE'});}
    });
    app.use('/pagamentos/controle-producao',(req,res,next)=>{req.auditBase='/pagamentos/controle-producao';next();},control);
    const sensitiveLogout=createProductionLogoutBridge({authorizer,logout});
    app.locals.infinitepayLogout=async(req,res,next)=>{
        try {
            const token=req.cookies?.token;
            if(typeof token!=='string' || !token || token.length>8192)return logout(req,res,next);
            // An expired or invalid JWT cannot acquire any new capability; its
            // cookie may be cleared without inventing a future session lifetime.
            try{jwt.verify(token,env.JWT_SECRET,{algorithms:['HS256'],clockTimestamp:Math.floor(now().getTime()/1000)});}
            catch{return logout(req,res,next);}
            const sessionHash=createHash('sha256').update('infinitepay-admin-session-v1\0'+token).digest('hex');
            const approval=await db('infinitepay_autorizacoes_producao').where({implantacao_id:config.databaseId,sessao_hash:sessionHash}).first('id');
            if(!approval)return logout(req,res,next);
            if(!req.get('X-Infinitepay-CSRF'))return res.status(409).set('Cache-Control','no-store').json({status:'fail',code:'FINANCIAL_SESSION_CSRF_REQUIRED'});
            return sensitiveLogout(req,res,next);
        }catch{return res.status(503).set('Cache-Control','no-store').json({status:'fail',code:'SESSION_END_UNAVAILABLE'});}
    };
    return {...application,async start(options) {
        // Boot keeps the control plane available while new, boot-bound approvals
        // are obtained. Starting a worker never creates an approval or enables flags.
        if(!await authorizer.authorize({operation:'WORKER',database:config.database,databaseId:config.databaseId,
            deploymentId:config.databaseId,environment:'production',publicOrigin:config.publicOrigin}))return;
        return application.start(options);
    }};
}
