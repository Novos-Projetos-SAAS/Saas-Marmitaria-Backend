import express from 'express';
import paymentRoutes from '../../src/routes/Pagamentos.Routes.js';
import { h1ProxyHeaders, trustH1Proxy } from '../../src/homologation/infinitepayH1Proxy.js';

export function createCreditApp({runtime,publicOrigin,verifyProxy=async()=>false,observe=async()=>{}}) {
    const origin=new URL(publicOrigin);
    if(origin.protocol!=='https:' || origin.origin!==publicOrigin || origin.username || origin.password) throw new Error('HTTPS exclusivo necessário.');
    const app=express();app.disable('x-powered-by');app.set('trust proxy',trustH1Proxy);
    app.locals.infinitepayRuntime=runtime;
    app.use((req,res,next)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
            'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"});
        if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
        if(req.get('host')!==origin.host && !/^127\.0\.0\.1:\d+$/.test(req.get('host')||'')) return res.sendStatus(403);
        const method={'/pagamentos/infinitepay/webhook':'POST','/pagamentos/infinitepay/retorno':'GET','/pedido/sucesso':'GET'}[req.path];
        if(!method)return res.sendStatus(404);
        if(req.method!==method)return res.sendStatus(405);
        next();
    });
    app.use(h1ProxyHeaders({publicHost:origin.host,verifyProxy}));
    app.use(express.json({limit:'32kb',inflate:false,verify:(req,_res,buffer)=>{req.creditRaw=buffer.toString('utf8');}}));
    app.post('/pagamentos/infinitepay/webhook',async(req,_res,next)=>{
        try{if(req.is('application/json'))await observe('WEBHOOK',{body:req.creditRaw,headers:req.headers});next();}catch{next({statusCode:503});}
    });
    app.get('/pagamentos/infinitepay/retorno',async(req,_res,next)=>{
        try{if(Object.keys(req.query).length)await observe('RETURN',{body:JSON.stringify(req.query),headers:req.headers});next();}catch{next({statusCode:503});}
    });
    app.get('/pedido/sucesso',(_req,res)=>res.type('text/plain').send('Homologação exclusiva de Crédito. Retorno não comprova pagamento.'));
    app.use('/pagamentos',paymentRoutes);
    app.use((error,_req,res,_next)=>res.status(error.statusCode || error.status || 500).json({status:'fail',message:'Callback não aceito.'}));
    return app;
}
