import {Router} from 'express';
import {readdir} from 'node:fs/promises';
import {assertProductionDatabase,validateProductionEnvironment} from '../config/infinitepayProduction.js';

export function createApplicationHealthRouter({db,env=process.env,cacheMs=500,deadlineMs=1500}) {
    if(typeof db!=='function' || !Number.isSafeInteger(cacheMs) || cacheMs<0 || !Number.isSafeInteger(deadlineMs) || deadlineMs<1 || deadlineMs>4000)throw new TypeError('Health inválido.');
    const router=Router(),catalog=readdir(new URL('../database/migrations/',import.meta.url));
    let pending,cached,checkedAt=0;
    async function check() {
        try {
            await db.raw('SELECT 1').timeout(deadlineMs);
            if(env.INFINITEPAY_MODE==='production') {
                await assertProductionDatabase(db,validateProductionEnvironment(env));
                const required=(await catalog).filter(name=>name.endsWith('.js'));
                const applied=new Set((await db('knex_migrations').select('name').timeout(deadlineMs)).map(row=>row.name));
                if(required.some(name=>!applied.has(name)))return false;
                for(const table of ['pagamentos','pagamentos_eventos','outbox_eventos','infinitepay_autorizacoes_producao','infinitepay_entregas_operacionais'])
                    if(!await db.schema.hasTable(table))return false;
            }
            return true;
        }catch{return false;}
    }
    function ready() {
        if(pending)return pending;
        if(cached!==undefined && Date.now()-checkedAt<cacheMs)return Promise.resolve(cached);
        let timer;
        const work=check();
        pending=Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),deadlineMs);})])
            .then(value=>{cached=value;checkedAt=Date.now();return value;}).finally(()=>clearTimeout(timer));
        // A timed-out read must not allow a request storm to queue more probes.
        void work.finally(()=>{pending=undefined;}).catch(()=>{});
        return pending;
    }
    router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
    router.get('/live',(req,res)=>res.json({status:'success',data:{live:true}}));
    router.get('/ready',async(req,res)=>{const value=await ready();res.status(value?200:503).json({status:value?'success':'fail',data:{ready:value}});});
    return router;
}
