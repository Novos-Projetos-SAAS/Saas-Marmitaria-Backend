import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObservedInfinitepayEvent, parseObservedCreatedLink, parseObservedPaymentCheck } from '../../src/services/infinitepayObservedContracts.js';

const base = { order_nsu: 'SYNTHETIC_ORDER', invoice_slug: 'SYNTHETIC_INVOICE' };
for (const type of ['created', 'paid', 'settled']) test('observed ' + type + ' maps identifiers without manufacturing transaction, receipt or financial proof', () => {
    assert.deepEqual(parseObservedInfinitepayEvent({ ...base, event_type: type, paid: true, amount: 100,
        receipt_url: 'https://untrusted.invalid/SYNTHETIC' }), { type, orderNsu: base.order_nsu, invoiceSlug: base.invoice_slug });
});
test('the observed slug alias is supported, but conflicting aliases are rejected', () => {
    assert.deepEqual(parseObservedInfinitepayEvent({ event_type: 'paid', order_nsu: base.order_nsu, slug: base.invoice_slug, transaction_nsu: 'SYNTHETIC_TX' }),
        { type: 'paid', orderNsu: base.order_nsu, invoiceSlug: base.invoice_slug, transactionNsu: 'SYNTHETIC_TX' });
    assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', slug: 'OTHER' }));
});
test('a present null invoice identifier cannot be replaced silently by the alias', () => {
    assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', invoice_slug: null, slug: base.invoice_slug }));
});
for (const field of ['order_nsu', 'invoice_slug', 'transaction_nsu']) test('null, blank and control characters are rejected in ' + field, () => {
    for (const value of [null, '', '   ', ' x', 'x\u200b', 'x\n']) {
        assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', [field]: value }));
    }
});
test('unobserved lifecycle event contracts are blocked instead of guessed', () => {
    for (const event_type of ['refunded', 'canceled', 'payment_failed', 'unknown', null]) {
        assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type }));
    }
});

test('normal checkout parser accepts only the observed url field on the exact HTTPS origin', () => {
    assert.deepEqual(parseObservedCreatedLink({url:'https://checkout.infinitepay.io/synthetic'}),{checkoutUrl:'https://checkout.infinitepay.io/synthetic'});
    for(const value of ['http://checkout.infinitepay.io/a','https://checkout.infinitepay.io.evil.test/a','https://evil.test/a',
        'https://checkout.infinitepay.io@evil.test/a','https://checkout.infinitepay.io/a#token','https://checkout.infinitepay.io/%0a']) assert.throws(()=>parseObservedCreatedLink({url:value}));
    for(const value of [{link:'https://checkout.infinitepay.io/a'},null,[],{url:' '}]) assert.throws(()=>parseObservedCreatedLink(value));
});
test('normal payment_check parser separates paid amount, checks echoed IDs and never invents lifecycle state', () => {
    const expected={orderNsu:'synthetic-order',invoiceSlug:'synthetic-slug',transactionNsu:'synthetic-txn'};
    const raw={success:true,paid:true,amount:100,paid_amount:110,installments:1,capture_method:'credit_card',financial_state:'ESTORNADA'};
    assert.deepEqual(parseObservedPaymentCheck(raw,expected),{paid:true,amount:100,paidAmount:110,installments:1,captureMethod:'credit_card'});
    for(const change of [{success:false},{order_nsu:'other'},{transaction_nsu:null},{slug:'other'},{receipt_url:'https://recibo.infinitepay.io/other'}]) assert.throws(()=>parseObservedPaymentCheck({...raw,...change},expected));
    assert.equal(parseObservedPaymentCheck({...raw,receipt_url:'https://recibo.infinitepay.io/synthetic-txn'},expected).receiptUrl,'https://recibo.infinitepay.io/synthetic-txn');
});
