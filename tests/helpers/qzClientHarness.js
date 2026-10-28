import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticQz as qz,printerOptions} from './qzSigningFixture.js';

// The actual installed client runs against a fake transport: no socket, QZ Tray or printer exists here.
export async function runQzClientHarness({f,identity}) {
    const preimages=new Map();let signatures=0,printRequests=0;
    class FakeWebSocket {
        static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
        constructor(){this.readyState=FakeWebSocket.CONNECTING;queueMicrotask(()=>{this.readyState=FakeWebSocket.OPEN;this.onopen?.({});});}
        send(raw) {
            const message=JSON.parse(raw);let result=null;
            if(message.call==='getVersion')result='2.2.6';
            else if(message.call==='printers.find' || message.call==='print') {
                const preimage=JSON.stringify({call:message.call,params:message.params,timestamp:message.timestamp});
                assert.equal(message.signAlgorithm,'SHA512');assert.equal(identity.verify(createHash('sha256').update(preimage).digest('hex'),message.signature),true);
                if(message.call==='printers.find')result=f.station.impressora;else printRequests++;
            }else assert.equal(message.certificate,identity.cert);
            queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({uid:message.uid,result})}));
        }
        close(){this.readyState=FakeWebSocket.CLOSED;queueMicrotask(()=>this.onclose?.({}));}
    }
    qz.api.setWebSocketType(FakeWebSocket);
    qz.api.setSha256Type(raw=>{const digest=createHash('sha256').update(raw).digest('hex');preimages.set(digest,raw);return digest;});
    qz.security.setCertificatePromise(accept=>accept(identity.cert));qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise(async digest=>{
        const message=preimages.get(digest);assert.ok(message);const command=JSON.parse(message);
        f.clock=new Date(command.timestamp);
        const prepared=await f.request('/prepare',{stationId:f.station.id,...(command.call==='print'?{documentId:f.doc.id}:{}),message,request:digest});
        assert.equal(prepared.status,201);
        const signed=await f.request('/sign',{intentId:prepared.data.intentId,request:digest});assert.equal(signed.status,200);
        assert.equal(identity.verify(digest,signed.text),true);signatures++;return signed.text;
    });
    try {
        await qz.websocket.connect({host:'synthetic.invalid.test',port:{secure:[8181],insecure:[]},usingSecure:true,keepAlive:0});
        const printer=await qz.printers.find(f.station.impressora);
        await qz.print(qz.configs.create(printer,printerOptions),structuredClone(f.doc.params.data));
        return {signatures,printRequests,physicalPrinting:false};
    }finally{if(qz.websocket.isActive())await qz.websocket.disconnect();preimages.clear();}
}
