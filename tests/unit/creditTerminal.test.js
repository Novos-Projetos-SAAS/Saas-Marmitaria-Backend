import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmCreditOperation } from '../../scripts/credit/terminal.js';
test('H4 confirmation refuses noninteractive input and requires the exact operation and amount',async()=>{
    await assert.rejects(confirmCreditOperation({operation:'CREATE_LINK',amount:100,publicOrigin:'https://synthetic.trycloudflare.com',input:new PassThrough(),output:new PassThrough()}));
    for(const [answer,wanted]of [['sim',false],['CREATE_LINK H4 CREDITO 101 CENTAVOS',false],['CREATE_LINK H4 CREDITO 100 CENTAVOS',true]]){
        const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;output.on('data',()=>{});
        const result=confirmCreditOperation({operation:'CREATE_LINK',amount:100,publicOrigin:'https://synthetic.trycloudflare.com',input,output});
        input.write(answer+'\n');assert.equal(await result,wanted);input.end();output.end();
    }
});
