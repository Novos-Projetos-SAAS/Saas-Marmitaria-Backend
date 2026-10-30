import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateProductionEnvironment, productionRequestAllowed,
    configureProductionProxy, productionProxyConfigured
} from '../src/config/infinitepayProduction.js';

const base = {
    NODE_ENV: 'production',
    INFINITEPAY_MODE: 'production',
    INFINITEPAY_ENABLED: 'false',
    INFINITEPAY_LOCAL_TEST: 'true',
    INFINITEPAY_BIND_HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:password@ep-test-pooler.us-east-2.aws.neon.tech/marmitaria?sslmode=require',
    INFINITEPAY_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
    FRONTEND_URL: 'https://marmitaria-git-checkout.vercel.app',
    BACKEND_URL: 'https://marmitaria-checkout-test.example.dev'
};

const request = (remoteAddress='127.0.0.1', headers={}) => ({
    socket: {remoteAddress},
    headers: {
        host:'marmitaria-checkout-test.example.dev',
        'x-forwarded-proto':'https',
        'x-forwarded-for':'198.51.100.10',
        origin:'https://marmitaria-git-checkout.vercel.app',
        ...headers
    }
});

test('local Windows can use the production financial profile via a local HTTPS tunnel', () => {
    const env={...base};
    // Resolution happens during server startup; validation must also work
    // when invoked on the raw environment object.
    const cfg = validateProductionEnvironment(env);
    assert.equal(cfg.mode, 'production');
    assert.equal(cfg.proxyMode, 'local-tunnel');
    assert.equal(cfg.bindHost, '127.0.0.1');
    assert.equal(cfg.database, 'marmitaria');
    assert.equal(cfg.publicOrigin, base.BACKEND_URL);
    assert.equal(cfg.successUrl, base.FRONTEND_URL + '/pedido/sucesso');
    assert.equal(productionRequestAllowed(request(),cfg),true);
    assert.equal(productionRequestAllowed(request('::ffff:127.0.0.1'),cfg),true);
    const app = {locals:{}, settings:{}, set(key,value){this.settings[key]=value;},use(fn){this.middleware=fn;}};
    configureProductionProxy(app,cfg);
    assert.equal(typeof app.settings['trust proxy'],'function');
    assert.equal(app.settings['trust proxy']('127.0.0.1',0),true);
    assert.equal(app.settings['trust proxy']('192.168.1.100',0),false);
    assert.equal(app.settings['trust proxy']('127.0.0.1',1),false);
    assert.equal(productionProxyConfigured(app,cfg),true);
});

test('local tunnel mode never accepts direct remote traffic or untrusted forwarded headers', () => {
    const cfg=validateProductionEnvironment(base);
    assert.equal(productionRequestAllowed(request('192.168.1.100'),cfg),false);
    assert.equal(productionRequestAllowed(request('::1'),cfg),true);
    for (const changes of [
        {host:'localhost:3333'},
        {'x-forwarded-proto':'http'},
        {'x-forwarded-for':'not-an-ip'},
        {'x-forwarded-for':''},
        {forwarded:'for=198.51.100.10'}
    ]) assert.equal(productionRequestAllowed(request('127.0.0.1',changes),cfg),false);
});

test('local tunnel must be explicitly enabled and cannot spoof Render', () => {
    for(const changes of [
        {INFINITEPAY_LOCAL_TEST:undefined},
        {INFINITEPAY_LOCAL_TEST:'yes'},
        {INFINITEPAY_BIND_HOST:'0.0.0.0'},
        {RENDER:'true'},
        {RENDER_EXTERNAL_URL:'https://example.onrender.com'},
        {BACKEND_URL:'https://example.onrender.com'},
        {BACKEND_URL:'http://localhost:3333'}
    ]) {
        assert.throws(
            () => validateProductionEnvironment({...base,...changes}),
            {code:'INFINITEPAY_PRODUCTION_BLOCKED'}
        );
    }
});
