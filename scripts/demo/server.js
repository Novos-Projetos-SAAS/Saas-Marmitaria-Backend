import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { loadDemoEnvironment, privateDirectory } from './environment.js';
import { createDemoProvider, DEMO_ORIGIN } from './provider.js';
import { closeDemo } from './shutdown.js';

const profile=await loadDemoEnvironment();
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options={})=>{
    const origin=new URL(typeof input==='string'?input:input.url).origin;
    if(![DEMO_ORIGIN,'https://localhost:55445'].includes(origin)) throw new Error('Rede externa bloqueada na demonstração.');
    return originalFetch(input,{...options,redirect:'error'});
};
const {default:app}=await import('../../src/app.js');
const {default:db}=await import('../../src/database/connection.js');
const {initializeInfinitepayApplication}=await import('../../src/infinitepayApplication.js');
const {verifyToken}=await import('../../src/middlewares/verifyToken.js');
const {checkPermission}=await import('../../src/middlewares/checkPermission.js');
const {requireActiveFinancialUser,protectInfinitepayWrite,csrfToken}=await import('../../src/middlewares/infinitepayAdminSecurity.js');
if((await db.raw('SELECT current_schema() AS schema')).rows[0].schema !== 'infinitepay_demo' ||
    (await db('demo_identity').first())?.purpose !== profile.purpose) throw new Error('Schema de demonstração recusado.');
const provider=createDemoProvider(db), gateway=express();
gateway.use((req,res,next)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== 'localhost:55446') return res.sendStatus(403);
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});next();
});
gateway.use(express.json({limit:'16kb'}),cookieParser());
gateway.use('/qz',(_req,res)=>res.status(403).json({status:'fail',message:'Impressão física bloqueada na demonstração.'}));
const admin=[verifyToken,requireActiveFinancialUser,checkPermission('pagamentos.configurar')];
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function page(res,title,body,script='') {
    const nonce=randomBytes(16).toString('base64');
    res.set('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin allow-forms allow-top-navigation allow-popups allow-downloads`);
    return res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
        <style>body{margin:24px auto;padding:0 16px;max-width:900px;background:#fafafa;color:#18181b;font:16px system-ui}h1{font-size:26px}article{background:white;border:1px solid #e4e4e7;border-radius:8px;padding:16px;margin:16px 0}button,select,a{display:inline-block;box-sizing:border-box;min-height:48px;padding:12px;margin:4px;max-width:100%;overflow-wrap:anywhere}button{background:#ea580c;color:white;border:0;border-radius:6px;cursor:pointer}strong{color:#9a3412}small{display:block;line-height:1.7}p{line-height:1.6}</style>
        <h1>${escape(title)}</h1><strong>DEMONSTRAÇÃO LOCAL — SEM DINHEIRO REAL</strong>${body}<p id="message" role="status"></p><script nonce="${nonce}">${script}</script></html>`);
}
async function webhook(token) {
    const response=await fetch(DEMO_ORIGIN+'/pagamentos/infinitepay/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await provider.event(token))});
    if(response.status!==200) throw new Error('Webhook sintético não foi persistido.');
}
gateway.get('/__demo/health',(_req,res)=>res.json({purpose:profile.purpose,pid:process.pid,worker:financial.status(),schema:'infinitepay_demo'}));
gateway.post('/__demo/stop',(req,res)=>{
    const supplied=Buffer.from(req.get('X-Demo-Operator')||''), expected=Buffer.from(profile.operatorToken);
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.sendStatus(403);
    res.json({status:'stopping'});setImmediate(()=>close().catch(()=>{process.exitCode=1;}));
});
gateway.get('/__demo',...admin,async(req,res,next)=>{
    try {
        const links=await db('demo_checkout_links as l').leftJoin('pagamentos as p','p.order_nsu','l.order_nsu').orderBy('l.created_at','desc')
            .select('l.token','l.paid','l.capture_method','l.amount','p.pedido_id','p.status');
        const settings=await db('demo_provider_settings').first();
        page(res,'Controle da demonstração',`<p>Entre primeiro na <a href="https://localhost:55445/auth/login">administração</a>. Use este painel apenas para simular o provedor. O backend continua verificando o pagamento de forma independente.</p>
            <article><label>Cenário do próximo checkout <select id="mode"><option value="PENDING">Pendente (padrão)</option><option value="UNCERTAIN">Resposta perdida após criar o link (INCERTA)</option><option value="ERROR">Erro de rede sem resposta (INCERTA)</option></select></label><button id="save">Aplicar ao próximo checkout</button><small>Seleção atual: ${escape(settings.creation_mode)}. Após um envio, volta a Pendente. Não há retentativa automática.</small></article>
            <p><a href="https://localhost:55445/pedido">Montar pedido</a><a href="https://localhost:55445/admin/pedidos">Administração</a><a href="https://localhost:55445/admin/relatorios">Relatórios</a></p>
            ${links.map(link=>`<article><h2>Pedido #${link.pedido_id??'em reserva'} · ${escape(link.status??'CRIANDO')}</h2><p>Valor sintético: R$ ${(link.amount/100).toFixed(2)}. Provedor: ${link.paid?'aprovado ('+escape(link.capture_method)+')':'pendente'}.</p><a href="/__demo/checkout/${link.token}" target="_blank" rel="noopener">Abrir checkout sintético</a><button data-repeat="${link.token}">Reenviar webhook</button></article>`).join('')}`,
            `const csrf=${JSON.stringify(csrfToken(req))};async function send(body){const r=await fetch('/__demo/action',{method:'POST',headers:{'Content-Type':'application/json','X-Infinitepay-CSRF':csrf},body:JSON.stringify(body)});document.querySelector('#message').textContent=r.ok?'Ação sintética registrada. Atualize a administração para consultar o backend.':'Ação recusada.';}
            document.querySelector('#save').onclick=()=>send({mode:document.querySelector('#mode').value});document.querySelectorAll('[data-repeat]').forEach(b=>b.onclick=()=>send({repeat:b.dataset.repeat}));`);
    } catch(error){next(error);}
});
gateway.post('/__demo/action',...admin,protectInfinitepayWrite,async(req,res,next)=>{
    try {
        if(req.body.mode && Object.keys(req.body).length===1) await provider.setMode(req.body.mode);
        else if(req.body.repeat && Object.keys(req.body).length===1) await webhook(req.body.repeat);
        else return res.sendStatus(400);
        res.json({status:'success'});
    } catch(error){next(error);}
});
const buyerCsrf=token=>createHmac('sha256',profile.operatorToken).update('demo-checkout:'+token).digest('base64url');
gateway.get('/__demo/checkout/:token',async(req,res,next)=>{
    try {
        const link=await provider.find(req.params.token), target=new URL(link.payload.redirect_url);
        for(const [key,value]of Object.entries({order_nsu:link.order_nsu,transaction_nsu:link.transaction_nsu,slug:link.invoice_slug}))target.searchParams.set(key,value);
        page(res,'Checkout simulado',`<article><p>Valor: <b>R$ ${(link.amount/100).toFixed(2)}</b></p><p>Estado do provedor sintético: ${link.paid?'aprovado':'pendente'}.</p>
            <button data-method="pix">Simular aprovação Pix</button><button data-method="credit_card">Simular aprovação Crédito</button>
            <p>Sem aprovação, o pedido permanece bloqueado. Aprovar modifica somente o provedor sintético e envia um webhook; o worker ainda precisa confirmar.</p>
            <a href="${escape(target.href)}">Voltar ao acompanhamento</a><a href="https://localhost:55445/pedido/sucesso">Continuar aguardando</a></article>`,
            `document.querySelectorAll('[data-method]').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:${JSON.stringify(buyerCsrf(link.token))},method:b.dataset.method})});document.querySelector('#message').textContent=r.ok?'Aprovação sintética enviada. Consulte o acompanhamento para confirmar o processamento pelo backend.':'Aprovação recusada.';b.disabled=false;});`);
    } catch(error){next(error);}
});
gateway.post('/__demo/checkout/:token',async(req,res,next)=>{
    try {
        if(req.get('Origin')!==DEMO_ORIGIN || req.get('Sec-Fetch-Site')==='cross-site' || !req.is('application/json') ||
            req.body.csrf!==buyerCsrf(req.params.token)) return res.sendStatus(403);
        await provider.approve(req.params.token,req.body.method);await webhook(req.params.token);res.json({status:'success'});
    } catch(error){next(error);}
});
gateway.get('/DEMO-:id',async(req,res,next)=>{
    try {
        if(!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
        const link=await db('demo_checkout_links').where({transaction_nsu:'DEMO-'+req.params.id,paid:true}).first();if(!link)return res.sendStatus(404);
        page(res,'Comprovante sintético',`<article><p>SEM VALOR FINANCEIRO. Nenhuma transação real foi realizada.</p><p>Valor original e pago: R$ ${(link.amount/100).toFixed(2)}.</p><p>Meio: ${escape(link.capture_method)}. Parcelas: 1. Taxas: não se aplicam à simulação.</p></article>`);
    } catch(error){next(error);}
});
gateway.use(app);
gateway.use((_error,_req,res,_next)=>res.status(400).json({status:'fail',message:'Operação de demonstração indisponível.'}));
const financial=await initializeInfinitepayApplication({app,db,transport:provider.transport});
const server=createServer({cert:await readFile(join(privateDirectory,'localhost.pem')),key:await readFile(join(privateDirectory,'localhost-key.pem'))},gateway);
const io=new Server(server,{cors:{origin:'https://localhost:55445',credentials:true}});
global.publicIo=io.of('/publico');global.io=io;
io.use(async(socket,next)=>{
    try {
        const value=(socket.request.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('token='))?.slice(6);
        const user=jwt.verify(value,process.env.JWT_SECRET);
        if(user.cargo!=='admin' || !await db('usuarios').where({id:user.id,ativo:true}).whereNull('deletado_em').first('id'))throw new Error();next();
    } catch{next(new Error('Sessão de demonstração exigida.'));}
});
io.on('connection',socket=>socket.join('pedidos'));
let closing;
async function close(){
    if(closing)return closing;
    closing=closeDemo({server,io,financial,db});
    return closing;
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().catch(()=>{process.exitCode=1;}));
server.on('error',()=>{console.error('Porta da demonstração indisponível. Nenhum serviço alheio será encerrado.');close();});
server.listen(55446,'127.0.0.1',()=>{financial.start();console.log('Backend de demonstração ativo em HTTPS localhost55446. Transporte financeiro exclusivamente sintético.');});
