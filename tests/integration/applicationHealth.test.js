import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createTestDatabase,testConnection} from '../helpers/testDatabase.js';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {validateProductionEnvironment} from '../../src/config/infinitepayProduction.js';

describe('public deployment health is bounded, sanitized and read-only',{concurrency:false},()=>{
    let f,db,make,server,base,env,queries=[];
    before(async()=>{
        ({createApplicationHealthRouter:make}=await import('../../src/routes/ApplicationHealth.Routes.js'));
        f=await createTestDatabase();db=f.db;await db.migrate.latest();env=syntheticProductionEnvironment(testConnection());
        await db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
        const app=express();app.use('/health',make({db,env,cacheMs:0}));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port+'/health';
    });
    after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await f?.close();});
    test('liveness needs no proxy headers/credentials; readiness verifies storage, migration ledger and deployment identity without writes',async()=>{
        const record=q=>queries.push(q.sql);db.on('query',record);
        try {
            assert.equal((await fetch(base+'/health/live')).status,404);
            assert.equal((await fetch(base+'/health')).status,404);
            assert.equal((await fetch(base+'/live')).status,200);
            const ready=await fetch(base+'/ready');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'success',data:{ready:true}});
            assert.equal(queries.some(q=>/^(insert|update|delete|create|drop|alter)\b/i.test(q)),false);
            assert.equal((await fetch(base+'/ready',{method:'POST'})).status,404);
        }finally{db.removeListener('query',record);}
    });
    test('missing migrations, wrong database identity and unavailable DB are unhealthy without leaking reasons',async()=>{
        await db('knex_migrations').where({name:'20261028000100_controles_administrativos.js'}).update({name:'SYNTHETIC_MISSING'});
        assert.equal((await fetch(base+'/ready')).status,503);
        await db('knex_migrations').where({name:'SYNTHETIC_MISSING'}).update({name:'20261028000100_controles_administrativos.js'});
        await db('infinitepay_identidade_ambiente').where({id:1}).update({ambiente:'NAO_CONFIGURADO'});
        assert.equal((await fetch(base+'/ready')).status,503);
        await db('infinitepay_identidade_ambiente').where({id:1}).update({ambiente:'PRODUCAO'});
        const fail=()=>{throw new Error('SYNTHETIC_SECRET_PASSWORD');};db.on('query',fail);
        try{const response=await fetch(base+'/ready');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/SECRET|PASSWORD|database|stack/);}
        finally{db.removeListener('query',fail);}
    });
    test('Render bind is explicit, with loopback default and no change to proxy authorization',()=>{
        assert.equal(validateProductionEnvironment(env).bindHost,'127.0.0.1');
        assert.equal(validateProductionEnvironment({...env,INFINITEPAY_BIND_HOST:'0.0.0.0'}).bindHost,'0.0.0.0');
        for(const value of ['::','localhost','192.0.2.1'])assert.throws(()=>validateProductionEnvironment({...env,INFINITEPAY_BIND_HOST:value}));
    });
    test('slow readiness times out and concurrent probes share the pending database read',async()=>{
        let calls=0,finish;
        const slow=()=>{};slow.raw=()=>({timeout(){calls++;return new Promise(resolve=>{finish=resolve;});}});
        const app=express();app.use(make({db:slow,env:{},deadlineMs:20,cacheMs:0}));
        const s=app.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));
        try {
            const url='http://127.0.0.1:'+s.address().port+'/ready';
            const responses=await Promise.all([fetch(url),fetch(url)]);assert.deepEqual(responses.map(r=>r.status),[503,503]);assert.equal(calls,1);
            assert.equal((await fetch(url)).status,503);assert.equal(calls,1);
            finish();
        }finally{finish?.();await new Promise(resolve=>s.close(resolve));}
    });
});
