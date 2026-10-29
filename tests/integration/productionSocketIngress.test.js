import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {Server} from 'socket.io';
import {syntheticProductionEnvironment} from '../helpers/productionEnvironment.js';
import {randomBytes} from 'node:crypto';
import * as policy from '../../src/config/infinitepayProduction.js';

test('Engine.IO enforces the same exact proxy and HTTPS contract before namespace authentication',async()=>{
    assert.equal(typeof policy.productionSocketAllowed,'function');
    const config=policy.validateProductionEnvironment(syntheticProductionEnvironment()),server=createServer();
    const io=new Server(server,{allowRequest:(req,callback)=>callback(null,policy.productionSocketAllowed(req,config,['https://shop.invalid.test']))});
    policy.configureProductionSocket(io,config,['https://shop.invalid.test']);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const headers={Host:'backend.invalid.test','X-Forwarded-Proto':'https','X-Forwarded-For':'203.0.113.7',Origin:'https://shop.invalid.test'};
    const probe=extra=>new Promise((resolve,reject)=>{
        const req=request('http://127.0.0.1:'+server.address().port+'/socket.io/?EIO=4&transport=polling',{headers:{...headers,...extra}},res=>{
            let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
        });req.on('error',reject);req.end();
    });
    try {
        const initial=await probe({});assert.equal(initial.status,200);const sid=JSON.parse(initial.body.slice(1)).sid;
        for(const extra of [{'X-Forwarded-Proto':'http'},{Origin:'https://evil.invalid.test'},{Origin:''},
            {'X-Forwarded-For':'203.0.113.7, 127.0.0.1'},{Forwarded:'for=127.0.0.1'},{Host:'evil.invalid.test'}])assert.ok([400,403].includes((await probe(extra)).status));
        const continued=await new Promise((resolve,reject)=>{
            const req=request('http://127.0.0.1:'+server.address().port+'/socket.io/?EIO=4&transport=polling&sid='+sid,
                {method:'POST',headers:{...headers,Host:'evil.invalid.test','Content-Type':'text/plain','Content-Length':2}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('40');
        });assert.ok([400,403].includes(continued),'an existing engine session cannot bypass proxy validation');
        const upgrade=await new Promise((resolve,reject)=>{
            const req=request('http://127.0.0.1:'+server.address().port+'/socket.io/?EIO=4&transport=websocket&sid='+sid,
                {headers:{...headers,Host:'evil.invalid.test',Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
            req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.on('error',reject);req.end();
        });assert.ok([400,403].includes(upgrade),'upgrade of an existing sid is checked before WebSocket acceptance');
        config.proxies=['192.0.2.40'];assert.ok([400,403].includes((await probe({'X-Forwarded-For':'192.0.2.40'})).status),'a forged header cannot replace the actual peer');
    }finally{await new Promise(resolve=>io.close(resolve));if(server.listening)await new Promise(resolve=>server.close(resolve));}
});
