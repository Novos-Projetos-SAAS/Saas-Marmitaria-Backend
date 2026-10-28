import { isIP } from 'node:net';

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
export function validateProductionEnvironment(env) {
    try {
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
        const proxies=(env.INFINITEPAY_TRUSTED_PROXY_IPS || '').split(',').map(v=>v.trim());
        if(!proxies.length || proxies.some(v=>!isIP(v) || ['0.0.0.0','::'].includes(v))) fail();
        let database=env.DB_NAME, host=env.DB_HOST, port=Number(env.DB_PORT || 5432);
        if(env.DATABASE_URL) {
            const url=new URL(env.DATABASE_URL);
            if(!['postgres:','postgresql:'].includes(url.protocol) || url.search || url.hash) fail();
            database=url.pathname.slice(1);host=url.hostname;port=Number(url.port || 5432);
        }
        if(database!==env.INFINITEPAY_DATABASE_NAME || !host || host!==host.trim() || !Number.isInteger(port) || port<1 || port>65535) fail();
        for(const key of ['INFINITEPAY_CHECKOUT_ENABLED','INFINITEPAY_WORKER_ENABLED','INFINITEPAY_VERIFY_ENABLED','INFINITEPAY_DELIVERY_ENABLED'])
            if(env[key]!==undefined && !['true','false',''].includes(env[key])) fail();
        return {mode:'production',database,databaseId:env.INFINITEPAY_DATABASE_ID.toLowerCase(),host,port,
            publicOrigin,successUrl:success.href,proxies};
    } catch { throw productionBlocked(); }
}
export async function assertProductionDatabase(db,config) {
    try {
        const connection=db.client.config.connection;
        if(db.client.config.searchPath?.includes('infinitepay_demo'))fail();
        let {host,database,port=5432}=connection || {};
        if(connection?.connectionString) {
            const url=new URL(connection.connectionString);
            if(!['postgres:','postgresql:'].includes(url.protocol) || url.search || url.hash) fail();
            host=url.hostname;database=url.pathname.slice(1);port=Number(url.port || 5432);
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
    const trusted=new Set(config.proxies.map(ip));
    app.set('trust proxy',(address,hop)=>hop===0 && trusted.has(ip(address)));
    app.use((req,res,next)=>{
        // One verified hop. The edge must overwrite these headers, never append client input.
        const forwarded=req.get('X-Forwarded-For');
        if(!trusted.has(ip(req.socket.remoteAddress)) || req.get('Host')!==new URL(config.publicOrigin).host ||
            req.get('X-Forwarded-Proto')!=='https' || !isIP(forwarded || '') ||
            req.get('Forwarded') || (req.get('X-Forwarded-Host') && req.get('X-Forwarded-Host')!==req.get('Host'))) {
            return res.status(403).json({status:'fail',message:'Proxy não autorizado.'});
        }
        next();
    });
    app.locals.infinitepayProductionProxy=JSON.stringify([config.publicOrigin,config.proxies]);
}
export function productionProxyConfigured(app,config) {
    return app.locals.infinitepayProductionProxy===JSON.stringify([config.publicOrigin,config.proxies]);
}
