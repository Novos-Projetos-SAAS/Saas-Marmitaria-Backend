import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCreditProfile } from '../../scripts/credit/environment.js';

test('credit preparation refuses shared databases, activation and keys from another profile', () => {
    const profile={purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',host:'127.0.0.1',port:55439,database:'infinitepay_credit_homologacao',user:'codex_test',encryptionKey:Buffer.alloc(32,1).toString('base64')};
    assert.doesNotThrow(()=>validateCreditProfile(profile));
    for(const patch of [{database:'infinitepay_phase1_test'},{database:'infinitepay_h1_homologacao'},{host:'production.invalid'},
        {port:55440},{purpose:'INFINITEPAY_LOCAL_SIMULATION_ONLY'},{checkoutEnabled:true},{encryptionKey:''}]){
        assert.throws(()=>validateCreditProfile({...profile,...patch}));
    }
});
