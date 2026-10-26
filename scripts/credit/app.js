import express from 'express';
import paymentRoutes from '../../src/routes/Pagamentos.Routes.js';

export function createCreditApp({runtime,publicOrigin}) {
    const origin=new URL(publicOrigin);
    if(origin.protocol!=='https:' || origin.origin!==publicOrigin || origin.username || origin.password) throw new Error('HTTPS exclusivo necessário.');
    const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
    app.locals.infinitepayRuntime=runtime;
    app.use((req,res,next)=>{
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
        if(req.get('host')!==origin.host && !/^127\.0\.0\.1:\d+$/.test(req.get('host')||'')) return res.sendStatus(403);
        // All callbacks share the local IP budget: no forwarded header is trusted as caller identity.
        for(const name of Object.keys(req.headers))if(/^(?:cf-|x-forwarded-|forwarded$)/i.test(name))delete req.headers[name];
        const method={'/pagamentos/infinitepay/webhook':'POST','/pagamentos/infinitepay/retorno':'GET','/pedido/sucesso':'GET'}[req.path];
        if(!method)return res.sendStatus(404);
        if(req.method!==method)return res.sendStatus(405);
        next();
    });
    app.use(express.json({limit:'32kb'}));
    app.get('/pedido/sucesso',(_req,res)=>res.type('text/plain').send('Homologação exclusiva de Crédito. Retorno não comprova pagamento.'));
    app.use('/pagamentos',paymentRoutes);
    app.use((error,_req,res,_next)=>res.status(error.statusCode || error.status || 500).json({status:'fail',message:'Callback não aceito.'}));
    return app;
}
