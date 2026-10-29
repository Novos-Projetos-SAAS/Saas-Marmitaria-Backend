import express from 'express';
import {createQzSigningFixture} from './qzSigningFixture.js';
import {createQzRoutes} from '../../src/routes/Qz.Routes.js';

export async function createQzIntegratedFixture(identity) {
    const f=await createQzSigningFixture(identity);f.qzMode='secure-test';f.legacyCalls=0;
    try {
        f.createProtectedServer=async({runtime,environment='test'}={})=>{
            if(runtime===undefined)runtime=await f.anotherSecureRuntime();
            const request=await f.additionalServer({mount:app=>{
                app.use(express.json());app.locals.qzSecureSigning=runtime;
                app.use('/qz',createQzRoutes({mode:()=>f.qzMode,environment:()=>environment,legacySign:(req,res)=>{f.legacyCalls++;res.send('LEGACY_REFERENCE');}}));
            }});
            const call=(path,body,options)=>request('/qz'+path,body,options);call.close=request.close;return call;
        };
        f.secureRequest=await f.createProtectedServer();
        f.secureBootstrap=async()=>{const response=await f.secureRequest('/csrf',{});if(response.status!==200)throw new Error('Bootstrap seguro recusado.');f.session.csrf=response.data.csrfToken;};
        return f;
    }catch(error){await f.close();throw error;}
}
