import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveFinancialEnvironment} from '../src/config/resolveFinancialEnvironment.js';

const sample = {
    NODE_ENV: 'production',
    INFINITEPAY_MODE: 'production',
    RENDER: 'true',
    RENDER_EXTERNAL_URL: 'https://marmitaria-api.onrender.com',
    DATABASE_URL: 'postgresql://user:encoded%40pass@ep-test.us-east-2.aws.neon.tech/marmitaria?sslmode=require',
    FRONTEND_URL: 'https://pedidos.example.com'
};

test('derives safe non-secret deployment settings but never payment flags', () => {
    const env = resolveFinancialEnvironment(sample);
    assert.equal(env.INFINITEPAY_DATABASE_NAME, 'marmitaria');
    assert.equal(env.INFINITEPAY_PUBLIC_ORIGIN, sample.RENDER_EXTERNAL_URL);
    assert.equal(env.INFINITEPAY_SUCCESS_URL, sample.FRONTEND_URL + '/pedido/sucesso');
    assert.equal(env.INFINITEPAY_ALLOWED_PUBLIC_ORIGINS, sample.RENDER_EXTERNAL_URL + ',' + sample.FRONTEND_URL);
    assert.equal(env.ALLOWED_ORIGINS, sample.FRONTEND_URL);
    assert.equal(env.INFINITEPAY_BIND_HOST, '0.0.0.0');
    assert.equal(env.INFINITEPAY_CHECKOUT_ENABLED, undefined);
    assert.equal(sample.INFINITEPAY_DATABASE_NAME, undefined);
});

test('explicit values remain authoritative', () => {
    const env = resolveFinancialEnvironment({...sample,
        INFINITEPAY_DATABASE_NAME: 'another',
        INFINITEPAY_PUBLIC_ORIGIN: 'https://api.example.com',
        INFINITEPAY_SUCCESS_URL: 'https://shop.example.com/pedido/sucesso',
        INFINITEPAY_ALLOWED_PUBLIC_ORIGINS: 'https://api.example.com,https://shop.example.com',
        ALLOWED_ORIGINS: 'https://shop.example.com',
        INFINITEPAY_BIND_HOST: '127.0.0.1'
    });
    assert.equal(env.INFINITEPAY_DATABASE_NAME, 'another');
    assert.equal(env.INFINITEPAY_PUBLIC_ORIGIN, 'https://api.example.com');
    assert.equal(env.INFINITEPAY_SUCCESS_URL, 'https://shop.example.com/pedido/sucesso');
    assert.equal(env.ALLOWED_ORIGINS, 'https://shop.example.com');
    assert.equal(env.INFINITEPAY_BIND_HOST, '127.0.0.1');
});

test('does not alter development, disabled or test environments', () => {
    for (const values of [
        {...sample, NODE_ENV: 'development'},
        {...sample, INFINITEPAY_MODE: 'disabled'},
        {...sample, NODE_ENV: 'test'}
    ]) {
        assert.deepEqual(resolveFinancialEnvironment(values), values);
    }
});

test('invalid frontend origin fails without enabling payments', () => {
    assert.throws(() => resolveFinancialEnvironment({...sample, FRONTEND_URL: 'not-a-url'}), TypeError);
});

test('master switch cannot override explicit per-capability shutdown or create approval', () => {
    const enabled=resolveFinancialEnvironment({...sample, INFINITEPAY_ENABLED:'true',
        INFINITEPAY_DELIVERY_ENABLED:'false'});
    assert.equal(enabled.INFINITEPAY_CHECKOUT_ENABLED,'true');
    assert.equal(enabled.INFINITEPAY_WORKER_ENABLED,'true');
    assert.equal(enabled.INFINITEPAY_VERIFY_ENABLED,'true');
    assert.equal(enabled.INFINITEPAY_DELIVERY_ENABLED,'false');
    const disabled=resolveFinancialEnvironment({...sample, INFINITEPAY_ENABLED:'false',
        INFINITEPAY_WORKER_ENABLED:'true'});
    assert.equal(disabled.INFINITEPAY_WORKER_ENABLED,'false');
    assert.equal(disabled.INFINITEPAY_CHECKOUT_ENABLED,'false');
    assert.throws(() => resolveFinancialEnvironment({...sample, INFINITEPAY_ENABLED:'yes'}));
});
