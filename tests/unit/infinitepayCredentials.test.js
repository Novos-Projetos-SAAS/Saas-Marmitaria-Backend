import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as mod from '../../src/utils/infinitepayCredentials.js';
test('authenticated encryption randomizes ciphertext, binds account and rejects tampering', () => {
    process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const first = mod.encryptApiKey('synthetic-api-secret', 'synthetic-store');
    const second = mod.encryptApiKey('synthetic-api-secret', 'synthetic-store');
    assert.equal(JSON.stringify(first).includes('synthetic-api-secret'), false);
    assert.notEqual(first.api_key_iv, second.api_key_iv);
    assert.equal(mod.decryptApiKey(first, 'synthetic-store'), 'synthetic-api-secret');
    assert.throws(() => mod.decryptApiKey(first, 'another-account'));
    assert.throws(() => mod.decryptApiKey({ ...first, api_key_tag: Buffer.alloc(16).toString('base64') }, 'synthetic-store'));
});
test('missing, malformed or unknown encryption keys fail closed without echoing the key', () => {
    process.env.INFINITEPAY_ENCRYPTION_KEY = 'SENTINEL_INVALID_KEY';
    assert.throws(() => mod.encryptApiKey('secret', 'store'), error => !error.message.includes('SENTINEL'));
    delete process.env.INFINITEPAY_ENCRYPTION_KEY;
    assert.throws(() => mod.encryptApiKey('secret', 'store'));
});
test('key ring decrypts historical version after selecting a new write key', () => {
    const v1 = randomBytes(32).toString('base64'), v2 = randomBytes(32).toString('base64');
    process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: v1, 2: v2 });
    process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
    const old = mod.encryptApiKey('synthetic-old-key', 'store');
    process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '2';
    assert.equal(mod.decryptApiKey(old, 'store'), 'synthetic-old-key');
    const current = mod.encryptApiKey('synthetic-new-key', 'store');
    assert.equal(current.key_version, 2);
    delete process.env.INFINITEPAY_ENCRYPTION_KEYS;
    delete process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION;
});
