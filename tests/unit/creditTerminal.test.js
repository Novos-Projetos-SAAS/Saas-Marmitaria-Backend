import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmCreditOperation, confirmCreditAuthorization } from '../../scripts/credit/terminal.js';
test('H4 confirmation refuses noninteractive input and requires the exact operation and amount',async()=>{
    await assert.rejects(confirmCreditOperation({operation:'CREATE_LINK',amount:100,publicOrigin:'https://synthetic.trycloudflare.com',input:new PassThrough(),output:new PassThrough()}));
    for(const [answer,wanted]of [['sim',false],['CREATE_LINK H4 CREDITO 101 CENTAVOS',false],['CREATE_LINK H4 CREDITO 100 CENTAVOS',true]]){
        const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;output.on('data',()=>{});
        const result=confirmCreditOperation({operation:'CREATE_LINK',amount:100,publicOrigin:'https://synthetic.trycloudflare.com',input,output});
        input.write(answer+'\n');assert.equal(await result,wanted);input.end();output.end();
    }
});
test('H4 registration requires interactive account, exact amount and uncertified minimum acknowledgment',async()=>{
    await assert.rejects(confirmCreditAuthorization({publicOrigin:'https://synthetic.trycloudflare.com',input:new PassThrough(),output:new PassThrough()}));
    for(const [answer,wanted] of [['sim',false],['AUTORIZO UM LINK H4 BRL 500 CREDITO 1X CONTA matheuszxp MINIMO NAO CONFIRMADO',false],
        ['AUTORIZO UM LINK H4 BRL 100 CREDITO 1X CONTA matheuszxp MINIMO NAO CONFIRMADO',true]]){
        const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;output.on('data',()=>{});
        const pending=confirmCreditAuthorization({publicOrigin:'https://synthetic.trycloudflare.com',input,output});
        input.write(answer+'\n');assert.equal(await pending,wanted);input.end();output.end();
    }
});
