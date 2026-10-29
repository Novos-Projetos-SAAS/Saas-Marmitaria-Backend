import {Router,json} from 'express';
import rateLimit from 'express-rate-limit';

// This factory is deliberately absent from the operational app, QZ routes and server.
export function createQzSigningPrototypeRouter({service,globalLimit=100,secureContract=false}) {
    if(['bootstrap','prepare','sign'].some(name=>typeof service?.[name]!=='function') || !Number.isSafeInteger(globalLimit) || globalLimit<1 || globalLimit>1000)throw new TypeError('Protótipo QZ indisponível.');
    const router=Router();
    router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
        if(!req.secure)return res.status(403).json({code:'QZ_AUTH_DENIED'});next();});
    router.use(rateLimit({windowMs:60000,limit:globalLimit,standardHeaders:true,legacyHeaders:false,
        handler:(req,res)=>res.status(429).json({code:'QZ_RATE_LIMIT'})}));
    router.use((req,res,next)=>{if(req.method==='POST' && !req.is('application/json'))return res.status(415).json({code:'QZ_JSON_REQUIRED'});next();},json({limit:'80kb',strict:true}));
    const session=req=>({token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')});
    const body=req=>{if(!req.body || Array.isArray(req.body) || Object.keys(req.body).includes('session'))throw Object.assign(new Error(),{code:'QZ_INVALID_REQUEST',statusCode:400});return req.body;};
    if(secureContract) {
        if(typeof service.issueDocument!=='function')throw new TypeError('Contrato QZ indisponível.');
        router.post('/csrf',async(req,res)=>{if(Object.keys(body(req)).length)throw Object.assign(new Error(),{code:'QZ_INVALID_REQUEST'});res.json(await service.bootstrap({session:session(req)}));});
        router.post('/documento',async(req,res)=>res.status(201).json(await service.issueDocument({...body(req),session:session(req)})));
    }else router.get('/csrf',async(req,res)=>res.json(await service.bootstrap({session:session(req)})));
    router.post('/prepare',async(req,res)=>res.status(201).json(await service.prepare({...body(req),session:session(req)})));
    router.post(secureContract?'/assinar':'/sign',async(req,res)=>res.type('text/plain').send(await service.sign({...body(req),session:session(req)})));
    router.use((error,req,res,next)=>{
        if(res.headersSent)return next(error);
        const code=error.type==='entity.parse.failed'?'QZ_INVALID_REQUEST':error.type==='entity.too.large'?'QZ_TOO_LARGE':
            ['QZ_AUTH_DENIED','QZ_INVALID_REQUEST','QZ_COMMAND_DENIED','QZ_REPLAY','QZ_RATE_LIMIT'].includes(error.code)?error.code:'QZ_UNAVAILABLE';
        const status={QZ_AUTH_DENIED:403,QZ_INVALID_REQUEST:400,QZ_COMMAND_DENIED:403,QZ_REPLAY:409,QZ_RATE_LIMIT:429,QZ_TOO_LARGE:413,QZ_UNAVAILABLE:503}[code];
        res.status(status).json({code});
    });
    return router;
}
