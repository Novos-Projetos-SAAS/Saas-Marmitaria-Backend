import { isIP } from 'node:net';
import {parsePostgresUrl} from './postgresConnection.js';
import {resolveFinancialEnvironment} from './resolveFinancialEnvironment.js';

export const productionBlocked = () => Object.assign(new Error('Produção InfinitePay indisponível: configuração ou autorização incompleta.'),
    {code:'INFINITEPAY_PRODUCTION_BLOCKED',statusCode:503});
const fail = () => { throw productionBlocked(); };
const local = host => ['127.0.0.1','localhost','::1','[::1]'].includes(host);
const ip = value => value?.startsWith('::ffff:') ? value.slice(7) : value;
function httpsOrigin(value) {
    const url=new URL(value);
    if(url.protocol!=='https:' || url.origin!==value || url.username || url.password) fail();
    return url;
}
export function validateProductionEnvironment(input) {
    try {
        const env = resolveFinancialEnvironment(input);
        if(env.NODE_ENV!=='production' || env.INFINITEPAY_MODE!=='production' || env.INFINITEPAY_DEMO ||
            !/^[a-z][a-z0-9_]{0,62}$/.test(env.INFINITEPAY_DATABASE_NAME || '') ||
            /(?:_homologacao|_demo)$/.test(env.INFINITEPAY_DATABASE_NAME) ||
            !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(env.INFINITEPAY_DATABASE_ID || '')) fail();
        const publicOrigin=httpsOrigin(env.INFINITEPAY_PUBLIC_ORIGIN).origin;
        const success=new URL(env.INFINITEPAY_SUCCESS_URL);
        httpsOrigin(success.origin);
        if(success.username || success.password || success.search || success.hash || success.pathname!=='/pedido/sucesso') fail();
        const allowed=(env.INFINITEPAY_ALLOWED_PUBLIC_ORIGINS || '').split(',').filter(Boolean).map(v=>httpsOrigin(v.trim()).origin);
        if(!allowed.includes(publicOrigin) || !allowed.includes(success.origin) ||
            !(env.ALLOWED_ORIGINS || '').split(',').map(v=>v.trim()).includes(success.origin)) fail();
        const proxies=(env.INFINITEPAY_TRUSTED_PROXY_IPS || '').split(',').map(v=>v.trim()).filter(Boolean);
        const bindHost=env.INFINITEPAY_BIND_HOST || '127.0.0.1';
        if(!['127.0.0.1','0.0.0.0'].includes(bindHost))fail();
        // Render terminates public HTTPS at its managed ingress. When its
        // runtime identity is present, no manually discovered proxy IPs are needed.
        // Outside Render, the explicit trusted-proxy allowlist remains mandatory.
        const renderUrl=env.RENDER_EXTERNAL_URL ? new URL(env.RENDER_EXTERNAL_URL) : null;
        const renderIngress=env.RENDER==='true' && env.RENDER_SERVICE_TYPE==='web' &&
            renderUrl?.protocol==='https:' && renderUrl.hostname.endsWith('.onrender.com') &&
            renderUrl.origin===env.RENDER_EXTERNAL_URL && bindHost==='0.0.0.0';
        if((!renderIngress && !proxies.length) || proxies.some(v=>!isIP(v) || ['0.0.0.0','::'].includes(v)))fail();
        const proxyMode=renderIngress && !proxies.length ? 'render' : 'allowlist';
        let database=env.DB_NAME, host=env.DB_HOST, port=Number(env.DB_PORT || 5432);
        if(env.DATABASE_URL) {
            const parsed = parsePostgresUrl(env.DATABASE_URL, {financialProduction:true});
            database=parsed.database;host=parsed.host;port=parsed.port;
        }
        if(database!==env.INFINITEPAY_DATABASE_NAME || !host || host!==host.trim() || !Number.isInteger(port) || port<1 || port>65535) fail();
        for(const key of ['INFINITEPAY_CHECKOUT_ENABLED','INFINITEPAY_WORKER_ENABLED','INFINITEPAY_VERIFY_ENABLED','INFINITEPAY_DELIVERY_ENABLED'])
            if(env[key]!==undefined && !['true','false',''].includes(env[key])) fail();
        return {mode:'production',database,databaseId:env.INFINITEPAY_DATABASE_ID.toLowerCase(),host,port,
            publicOrigin,successUrl:success.href,proxies,proxyMode,bindHost};
    } catch { throw productionBlocked(); }
}
export async function assertProductionDatabase(db,config) {
    try {
        const connection=db.client.config.connection;
        if(db.client.config.searchPath?.includes('infinitepay_demo'))fail();
        let {host,database,port=5432}=connection || {};
        if(connection?.connectionString) {
            const parsed = parsePostgresUrl(connection.connectionString, {financialProduction:true});
            host=parsed.host;database=parsed.database;port=parsed.port;
        }
        if(host!==config.host || database!==config.database || Number(port)!==config.port ||
            (!local(host) && (!connection.ssl || connection.ssl===true || connection.ssl.rejectUnauthorized!==true))) fail();
        const actual=(await db.raw('SELECT current_database() AS name,current_schema() AS schema')).rows[0];
        if(actual.name!==config.database || actual.schema==='infinitepay_demo') fail();
        const marker=await db('infinitepay_identidade_ambiente').where({id:1}).first();
        if(marker?.ambiente!=='PRODUCAO' || marker.identidade!==config.databaseId) fail();
    } catch { throw productionBlocked(); }
}
export function configureProductionProxy(app,config) {
    if(config.proxyMode==='render') {
        // Render owns the HTTP ingress; trust only the immediately adjacent
        // Render hop, never arbitrary client-supplied X-Forwarded-For entries.
        app.set('trust proxy',1);
    } else {
        const trusted=new Set(config.proxies.map(ip));
        app.set('trust proxy',(address,hop)=>hop===0 && trusted.has(ip(address)));
    }
    app.use((req,res,next)=>{
        // One verified hop. The edge must overwrite these headers, never append client input.
        if(!productionRequestAllowed(req,config)) {
            return res.status(403).json({status:'fail',message:'Proxy não autorizado.'});
        }
        next();
    });
    app.locals.infinitepayProductionProxy=JSON.stringify([config.publicOrigin,config.proxyMode,config.proxies]);
}
export function productionRequestAllowed(req,config) {
    const h=req.headers || {},forwarded=h['x-forwarded-for'];
    // Render can append a proxy chain. Validate its syntax, but never treat
    // any client-controllable entry as proof of proxy identity.
    const chain=typeof forwarded==='string' ? forwarded.split(',').map(v=>v.trim()) : [];
    const validChain=chain.length>0 && chain.length<=16 && chain.every(v=>isIP(v)!==0);
    const remote=ip(req.socket?.remoteAddress);
    const trustedIngress=config.proxyMode==='render'
        ? isIP(remote)!==0
        : config.proxies.map(ip).includes(remote);
    return trustedIngress && validChain && h.host===new URL(config.publicOrigin).host &&
        h['x-forwarded-proto']==='https' && !h.forwarded &&
        (!h['x-forwarded-host'] || h['x-forwarded-host']===h.host);
}
export function productionSocketAllowed(req,config,origins) {
    return productionRequestAllowed(req,config) && typeof req.headers.origin==='string' && origins.includes(req.headers.origin);
}
export function configureProductionSocket(io,config,origins) {
    // Engine.IO bypasses Express, including polling/upgrade of an existing sid.
    io.engine.use((req,res,next)=>productionSocketAllowed(req,config,origins)?next():next(new Error('Proxy não autorizado.')));
}
export function productionProxyConfigured(app,config) {
    return app.locals.infinitepayProductionProxy===JSON.stringify([config.publicOrigin,config.proxyMode,config.proxies]);
}
