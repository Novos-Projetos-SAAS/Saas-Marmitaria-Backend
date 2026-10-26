import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditProof } from '../../scripts/credit/verification.js';
const expected={orderNsu:'SYNTHETIC-ORDER',transactionNsu:'SYNTHETIC-TX',invoiceSlug:'SYNTHETIC-INVOICE'};
const proof={success:true,paid:true,amount:100,paid_amount:103,capture_method:'credit_card',installments:1,receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TX'};
test('credit proof preserves provider paid amount separately from the original amount without inventing fees',()=>{
    const valid=creditProof(proof,expected,100);assert.equal(valid.amount,100);assert.equal(valid.paidAmount,103);assert.equal(valid.captureMethod,'credit_card');
});
for(const [name,patch]of [['missing success',{success:undefined}],['not successful',{success:false}],['not paid',{paid:false}],['wrong original amount',{amount:101}],
    ['negative paid amount',{paid_amount:-1}],['Pix instead of credit',{capture_method:'pix'}],['unexpected installments',{installments:2}],
    ['conflicting transaction',{transaction_nsu:'OTHER'}],['conflicting invoice',{slug:'OTHER'}],['unauthorized receipt',{receipt_url:'https://evil.invalid/SYNTHETIC-TX'}],
    ['wrong receipt transaction',{receipt_url:'https://recibo.infinitepay.io/OTHER'}],['missing receipt',{receipt_url:undefined}]]){
    test('credit proof blocks '+name,()=>assert.throws(()=>creditProof({...proof,...patch},expected,100)));
}
