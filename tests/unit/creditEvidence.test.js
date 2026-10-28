import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeCreditEvidence } from '../../scripts/credit/evidence.js';
import { digest } from '../../scripts/credit/observations.js';
const expected={orderNsu:'SYNTHETIC-ORDER',transactionNsu:'SYNTHETIC-TX',invoiceSlug:'SYNTHETIC-INVOICE'};
const data={success:true,paid:true,amount:100,paid_amount:100,capture_method:'credit_card',installments:1};
const raw={event_type:'paid',order_nsu:'SYNTHETIC-ORDER',transaction_nsu:'SYNTHETIC-TX',invoice_slug:'SYNTHETIC-INVOICE',receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TX'};
const webhook=patch=>({kind:'WEBHOOK',raw:{...raw,...patch},reference:{id:11,hash:'a'.repeat(64)}});
const compose=callbacks=>composeCreditEvidence({data,expected,amount:100,callbacks,returnNonceHash:digest('SYNTHETIC-NONCE')});
test('H4 separates the independent payment_check from a correlated persisted receipt without rewriting either source',()=>{
    const callbacks=[webhook()],before=JSON.stringify({data,callbacks}),result=compose(callbacks);
    assert.equal(result.financial.paid,true);assert.equal(result.financial.receiptUrl,undefined);
    assert.equal(result.receipt.url,'https://recibo.infinitepay.io/SYNTHETIC-TX');assert.equal(result.receipt.status,'VALIDATED');
    assert.deepEqual(result.receipt.sources,['PERSISTED_WEBHOOK']);assert.equal(result.reconciliationReady,true);
    assert.equal(JSON.stringify({data,callbacks}),before);
});
test('H4 can confirm independent payment with no receipt while keeping receipt availability false',()=>{
    const result=compose([webhook({receipt_url:undefined})]);assert.equal(result.financial.paid,true);
    assert.equal(result.receipt.status,'ABSENT');assert.equal(result.receipt.url,undefined);assert.equal(result.reconciliationReady,true);
});
for(const [name,patch] of [['another transaction',{receipt_url:'https://recibo.infinitepay.io/OTHER'}],['unauthorized domain',{receipt_url:'https://evil.invalid/SYNTHETIC-TX'}],
    ['HTTP',{receipt_url:'http://recibo.infinitepay.io/SYNTHETIC-TX'}],['mismatched identifiers',{transaction_nsu:'OTHER'}],
    ['mismatched invoice',{invoice_slug:'OTHER'}],['unbound transaction',{transaction_nsu:undefined}],['wrong method',{capture_method:'pix'}]]){
    test('H4 blocks receipt association and reconciliation for '+name,()=>{
        const result=compose([webhook(patch)]);assert.equal(result.financial.paid,true);
        assert.equal(result.receipt.status,'BLOCKED');assert.equal(result.receipt.url,undefined);assert.equal(result.reconciliationReady,false);
    });
}
test('H4 validates return nonce and deduplicates repeated receipt observations',()=>{
    const callback={kind:'RETURN',raw:{...raw,r:'SYNTHETIC-NONCE',slug:'SYNTHETIC-INVOICE'},reference:{id:12,hash:'b'.repeat(64)}};
    const result=compose([webhook(),webhook(),callback,callback]);assert.equal(result.receipt.status,'VALIDATED');
    assert.equal(result.receipt.references.length,2);assert.deepEqual(result.receipt.sources,['PERSISTED_RETURN','PERSISTED_WEBHOOK']);
    assert.equal(compose([{...callback,raw:{...callback.raw,r:'OTHER'}}]).reconciliationReady,false);
});
test('a paid webhook cannot substitute negative or incompatible independent financial proof',()=>{
    for(const patch of [{paid:false},{amount:101},{capture_method:'pix'},{installments:2},{success:false}]){
        assert.throws(()=>composeCreditEvidence({data:{...data,...patch},expected,amount:100,callbacks:[webhook()]}));
    }
});
test('H4 does not choose between different receipt URLs associated with the same transaction',()=>{
    const result=compose([webhook(),webhook({receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TX?other=1'})]);
    assert.equal(result.financial.paid,true);assert.equal(result.receipt.status,'BLOCKED');assert.equal(result.reconciliationReady,false);
});
