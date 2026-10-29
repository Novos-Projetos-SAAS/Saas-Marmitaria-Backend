import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID,verify,X509Certificate} from 'node:crypto';

// Load the frontend service with a private QZ and fake Tray. Integrated mode
// forwards HTTP only: the frontend itself supplies CSRF, preimage and intent.
export async function createFrontendQzHarness({f,identity,document=f.doc,presentedCertificate=identity.cert,headers={},mutate,afterPrepare,afterSign,corruptSignature=false,integrated=false,clientMode='secure-test',stationId=f.station.id}={}) {
    const key='synthetic-qz-client-'+randomUUID(),registry=Symbol.for(key),preimages=new Map(),logs=[],sockets=new Set();
    const state={acceptedPrints:0,verifiedSignatures:0,prepareCalls:0,signCalls:0,csrfCalls:0,physicalPrinting:false};
    const oldCertificate=process.env.NEXT_PUBLIC_QZ_CERTIFICATE,oldConsole=globalThis.console;
    const previousMode=process.env.NEXT_PUBLIC_QZ_SIGNING_MODE,previousStation=process.env.NEXT_PUBLIC_QZ_STATION_ID;
    const serviceFile=new URL('../../../Saas-Marmitaria-Frontend/src/services/qzService.js',import.meta.url),serviceUrl=serviceFile.href+'?fixture='+key;
    const libraryFile=new URL('../../../Saas-Marmitaria-Frontend/node_modules/qz-tray/qz-tray.js',import.meta.url),libraryUrl='qz-fixture:'+key+'/library';
    let hooks,service,csrf,qz,closed=false;
    const error=()=>new Error('SYNTHETIC_QZ_REQUEST_REJECTED');
    const collect=(...values)=>logs.push(values.map(value=>value instanceof Error?value.message:typeof value==='string'?value:JSON.stringify(value)).join(' '));
    globalThis.console={...oldConsole,log:collect,info:collect,warn:collect,error:collect};
    process.env.NEXT_PUBLIC_QZ_CERTIFICATE=presentedCertificate;
    process.env.NEXT_PUBLIC_QZ_SIGNING_MODE=integrated?clientMode:'legacy';
    if(stationId===undefined)delete process.env.NEXT_PUBLIC_QZ_STATION_ID;else process.env.NEXT_PUBLIC_QZ_STATION_ID=stationId;
    const trusted=new X509Certificate(identity.cert);
    class FakeWebSocket {
        static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
        constructor(){sockets.add(this);this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.({});});}
        send(raw) {
            const message=JSON.parse(raw);let result=null,denied=false;
            if(message.call==='getVersion')result='2.2.6';
            else if(message.call==='printers.find' || message.call==='print') {
                const original=JSON.stringify({call:message.call,params:message.params,timestamp:message.timestamp}),digest=createHash('sha256').update(original).digest('hex');
                denied=message.signAlgorithm!=='SHA512' || !verify('RSA-SHA512',Buffer.from(digest),trusted.publicKey,Buffer.from(message.signature || '','base64'));
                if(!denied){state.verifiedSignatures++;if(message.call==='print')state.acceptedPrints++;else result=f.station.impressora;}
            }else {
                try{denied=new X509Certificate(message.certificate).fingerprint256!==trusted.fingerprint256;}catch{denied=true;}
            }
            queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({uid:message.uid,...(denied?{error:'SYNTHETIC_QZ_IDENTITY_DENIED'}:{result})})}));
        }
        close(){clearInterval(this.interval);sockets.delete(this);this.readyState=3;queueMicrotask(()=>this.onclose?.({}));}
    }
    const callTypes=new Map();
    const api={async post(path,input,config={}) {
        if(integrated) {
            if(closed || !['/qz/csrf','/qz/documento','/qz/prepare','/qz/assinar'].includes(path))throw error();
            let body=input,call;
            if(path==='/qz/prepare') {
                call=JSON.parse(body.message).call;f.clock=new Date(Math.max(f.clock.getTime(),JSON.parse(body.message).timestamp));
                body=await mutate?.(body,call) || body;state.prepareCalls++;
            }
            if(path==='/qz/csrf')state.csrfCalls++;
            if(path==='/qz/assinar'){state.signCalls++;call=callTypes.get(body.intentId);}
            const response=await f.secureRequest(path.slice(3),body,{headers:{...config.headers,...headers},signal:config.signal});
            if(response.status>=400)throw error();
            if(path==='/qz/prepare'){callTypes.set(response.data.intentId,call);await afterPrepare?.({call,intentId:response.data.intentId,body});}
            if(path==='/qz/assinar')await afterSign?.({call,intentId:body.intentId});
            return {data:path==='/qz/assinar'?(corruptSignature && call==='print'?'AA==':response.text):response.data};
        }
        if(closed || path!=='/qz/assinar' || !/^[a-f0-9]{64}$/.test(input?.request))throw error();
        const message=preimages.get(input.request);if(!message)throw error();preimages.delete(input.request);
        const command=JSON.parse(message);f.clock=new Date(Math.max(f.clock.getTime(),command.timestamp));
        if(!csrf){state.csrfCalls++;const response=await f.request('/csrf',undefined,{method:'GET',headers});if(response.status!==200)throw error();csrf=response.data.csrfToken;}
        const requestHeaders={'X-Infinitepay-CSRF':csrf,...headers};
        let body={stationId:f.station.id,...(command.call==='print'?{documentId:document.id}:{}),message,request:input.request};
        body=await mutate?.(body,command.call) || body;
        state.prepareCalls++;const prepared=await f.request('/prepare',body,{headers:requestHeaders});if(prepared.status!==201)throw error();
        await afterPrepare?.({call:command.call,intentId:prepared.data.intentId,body});
        state.signCalls++;const signed=await f.request('/sign',{intentId:prepared.data.intentId,request:body.request},{headers:requestHeaders});
        if(signed.status!==200)throw error();await afterSign?.({call:command.call,intentId:prepared.data.intentId});
        return {data:corruptSignature && command.call==='print'?'AA==':signed.text};
    }};
    globalThis[registry]={api};
    hooks=registerHooks({
        resolve(specifier,context,next) {
            if(context.parentURL===serviceUrl && ['qz-tray','./api'].includes(specifier))return {url:specifier==='qz-tray'?libraryUrl:'qz-fixture:'+key+'/api',shortCircuit:true};
            return next(specifier,context);
        },
        load(url,context,next) {
            if(url===serviceUrl)return {format:'module',source:readFileSync(serviceFile,'utf8'),shortCircuit:true};
            if(url===libraryUrl)return {format:'module',source:'const module={exports:{}}; const exports=module.exports;\n'+readFileSync(libraryFile,'utf8')+'\nexport default module.exports;',shortCircuit:true};
            if(url==='qz-fixture:'+key+'/api')return {format:'module',source:'export default globalThis[Symbol.for('+JSON.stringify(key)+')].api;',shortCircuit:true};
            return next(url,context);
        }
    });
    const close=async()=>{
        if(closed)return;closed=true;
        try{if(qz?.websocket.isActive())await qz.websocket.disconnect();}finally{
            // A failed handshake can clear QZ's connection reference before its keepalive expires.
            for(const socket of sockets){clearInterval(socket.interval);socket.readyState=3;socket.onopen=socket.onmessage=socket.onerror=socket.onclose=undefined;}sockets.clear();
            hooks?.deregister();delete globalThis[registry];preimages.clear();globalThis.console=oldConsole;
            if(oldCertificate===undefined)delete process.env.NEXT_PUBLIC_QZ_CERTIFICATE;else process.env.NEXT_PUBLIC_QZ_CERTIFICATE=oldCertificate;
            if(previousMode===undefined)delete process.env.NEXT_PUBLIC_QZ_SIGNING_MODE;else process.env.NEXT_PUBLIC_QZ_SIGNING_MODE=previousMode;
            if(previousStation===undefined)delete process.env.NEXT_PUBLIC_QZ_STATION_ID;else process.env.NEXT_PUBLIC_QZ_STATION_ID=previousStation;
        }
    };
    try {
        qz=(await import(libraryUrl)).default;
        qz.api.setWebSocketType(FakeWebSocket);
        qz.api.setSha256Type(message=>{const digest=createHash('sha256').update(message).digest('hex');preimages.set(digest,message);return digest;});
        service=await import(serviceUrl);
        return {state,logs,library:qz,connect:()=>closed?Promise.reject(error()):service.conectarQZ(),
            print:(html=document.html,printer=f.station.impressora)=>closed?Promise.reject(error()):service.imprimirCupom(html,printer,{pedidoId:document.pedido_id}),close};
    }catch(failure){await close();throw failure;}
}
