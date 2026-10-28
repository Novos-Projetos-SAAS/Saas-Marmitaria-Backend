import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProductionLogoutBridge} from '../../src/middlewares/productionLogoutBridge.js';
import {logout} from '../../src/utils/logoutResponse.js';
const req={secure:true,cookies:{token:'SYNTHETIC_JWT'},get:name=>({Origin:'https://shop.invalid.test','X-Infinitepay-CSRF':'SYNTHETIC_CSRF'})[name]};
function response(){return {statusCode:200,headers:{},set(value){Object.assign(this.headers,value);return this;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
test('logout bridge waits for durable completion before delegating to the legacy response',async()=>{
    const calls=[],res=response();
    const bridge=createProductionLogoutBridge({authorizer:{async endSession(input){assert.equal(input.session.token,req.cookies.token);calls.push('durable');return {ended:true};}},
        async logout(){calls.push('cookie');}});
    await bridge(req,res,()=>{});assert.deepEqual(calls,['durable','cookie']);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('logout bridge denies insecure transport, incomplete result and failed persistence without clearing cookies',async()=>{
    for(const result of [undefined,false,{ended:false},new Error('SYNTHETIC_SECRET'),Object.assign(new Error('SYNTHETIC_SECRET'),{code:'SESSION_ENDED_AUDIT_PENDING'})]) {
        let cleared=false;const res=response(),bridge=createProductionLogoutBridge({authorizer:{async endSession(){if(result instanceof Error)throw result;return result;}},logout(){cleared=true;}});
        await bridge(req,res,()=>{});assert.equal(cleared,false);assert.equal(res.statusCode,503);assert.equal(JSON.stringify(res.body).includes('SYNTHETIC_SECRET'),false);
    }
    const res=response();await createProductionLogoutBridge({authorizer:{endSession(){throw new Error();}},logout(){throw new Error();}})({...req,secure:false},res,()=>{});
    assert.equal(res.statusCode,403);
});
test('legacy logout keeps its existing response and cookie options in development and production',async()=>{
    const old=process.env.NODE_ENV;
    try{for(const mode of ['development','production']){
        process.env.NODE_ENV=mode;const res=response();let cookie;
        res.clearCookie=(name,options)=>{cookie={name,options};};await logout({},res,error=>{throw error;});
        assert.deepEqual(cookie,{name:'token',options:{httpOnly:true,secure:mode==='production',sameSite:mode==='production'?'none':'lax'}});
        assert.deepEqual(res.body,{status:'success',message:'Logout realizado com sucesso. Até logo!'});assert.equal(res.statusCode,200);
    }}finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
