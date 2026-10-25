import test from 'node:test';
import assert from 'node:assert/strict';
import { providerOrigins } from '../../src/config/infinitepayProviderOrigins.js';
import { parseObservedCreatedLink, parseObservedPaymentCheck, receiptMatchesTransaction } from '../../src/services/infinitepayObservedContracts.js';

export const demoProfile = { NODE_ENV:'development', INFINITEPAY_MODE:'homologation', INFINITEPAY_DEMO:'local-only',
    DB_HOST:'127.0.0.1', DB_PORT:'55439', DB_NAME:'infinitepay_phase1_test', DATABASE_URL:'', INFINITEPAY_DATABASE_NAME:'infinitepay_phase1_test' };
test('demo origins require the explicit local development profile and cannot target H1 or production', () => {
    assert.equal(providerOrigins({}).checkoutOrigin,'https://checkout.infinitepay.io');
    assert.equal(providerOrigins(demoProfile).checkoutOrigin,'https://localhost:55446');
    for(const extra of [{NODE_ENV:'production'},{NODE_ENV:'test'},{DB_HOST:'production.invalid'},{DB_PORT:'55440'},
        {DB_NAME:'infinitepay_h1_homologacao'},{DATABASE_URL:'postgres://production.invalid/main'},{INFINITEPAY_MODE:'disabled'},{INFINITEPAY_DEMO:'typo'}])
        assert.throws(()=>providerOrigins({...demoProfile,...extra}));
});
test('local response and receipt contracts remain strict and real defaults reject local URLs', () => {
    const checkoutOrigins=['https://localhost:55446'], receiptOrigins=checkoutOrigins;
    const url='https://localhost:55446/__demo/checkout/SYNTHETIC';
    assert.throws(()=>parseObservedCreatedLink({url}));
    assert.equal(parseObservedCreatedLink({url},{checkoutOrigins}).checkoutUrl,url);
    for(const value of ['http://localhost:55446/a','https://localhost:55446.evil.test/a','https://user@localhost:55446/a','https://localhost:55446/a#b'])
        assert.throws(()=>parseObservedCreatedLink({url:value},{checkoutOrigins}));
    const receipt='https://localhost:55446/DEMO-TXN';
    assert.equal(receiptMatchesTransaction(receipt,'DEMO-TXN'),false);
    assert.equal(receiptMatchesTransaction(receipt,'DEMO-TXN',receiptOrigins),true);
    assert.equal(parseObservedPaymentCheck({paid:true,receipt_url:receipt},{transactionNsu:'DEMO-TXN'},{receiptOrigins}).receiptUrl,receipt);
});
