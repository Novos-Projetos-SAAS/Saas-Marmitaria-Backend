import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import express from 'express';
import {createQzRoutes} from '../../src/routes/Qz.Routes.js';

async function fixture(environment,mode) {
    let legacyCalls=0;
    const app=express();app.use(express.json());
    app.use('/qz',createQzRoutes({environment:()=>environment,mode:()=>mode,
        legacySign:(req,res)=>{legacyCalls++;res.send('UNSAFE_REFERENCE');}}));
    const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {legacyCalls:()=>legacyCalls,send:(method='POST',path='/qz/assinar')=>new Promise((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,
            headers:{'Content-Type':'application/json',Cookie:'token=SYNTHETIC_SESSION','X-Infinitepay-CSRF':'SYNTHETIC'}},res=>{
            let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
        });req.on('error',reject);req.end(method==='POST'?'{"request":"SYNTHETIC_HASH"}':undefined);
    }),close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('public and incomplete environments never mount legacy signing even with credentials and cookies present',async()=>{
    const previous=process.env.QZ_PRIVATE_KEY;process.env.QZ_PRIVATE_KEY='SYNTHETIC_UNUSABLE_CREDENTIAL';
    try {
        for(const environment of ['production',undefined,'development','unknown'])for(const mode of [undefined,'legacy','secure-test','disabled']) {
            const f=await fixture(environment,mode);
            try{const response=await f.send();assert.equal(response.status,503,`${environment}/${mode}`);
                assert.equal(response.headers['cache-control'],'no-store');assert.equal(f.legacyCalls(),0);
                assert.equal(response.body.includes('SYNTHETIC_UNUSABLE_CREDENTIAL'),false);
            }finally{await f.close();}
        }
    }finally{if(previous===undefined)delete process.env.QZ_PRIVATE_KEY;else process.env.QZ_PRIVATE_KEY=previous;}
});

test('production blocks every QZ method and alias without invoking a signer',async()=>{
    const f=await fixture('production','secure-test');
    try{for(const method of ['GET','POST','PUT','OPTIONS'])for(const path of ['/qz/assinar','/qz/sign','/qz/csrf','/qz/documento'])
        assert.equal((await f.send(method,path)).status,503);assert.equal(f.legacyCalls(),0);
    }finally{await f.close();}
});
