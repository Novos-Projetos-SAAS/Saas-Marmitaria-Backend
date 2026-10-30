import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateProductionEnvironment, productionRequestAllowed, configureProductionProxy
} from '../src/config/infinitepayProduction.js';

const renderEnv = {
    NODE_ENV: 'production',
    INFINITEPAY_MODE: 'production',
    DATABASE_URL: 'postgresql://operator:pw@ep-example.us-east-2.aws.neon.tech/marmitaria?sslmode=require',
    INFINITEPAY_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
    INFINITEPAY_PUBLIC_ORIGIN: 'https://marmitaria-api.onrender.com',
    INFINITEPAY_SUCCESS_URL: 'https://orders.example.com/pedido/sucesso',
    INFINITEPAY_ALLOWED_PUBLIC_ORIGINS: 'https://marmitaria-api.onrender.com,https://orders.example.com',
    ALLOWED_ORIGINS: 'https://orders.example.com',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    RENDER_EXTERNAL_URL: 'https://marmitaria-api.onrender.com',
    INFINITEPAY_BIND_HOST: '0.0.0.0'
};
const request = {
    socket: {remoteAddress:'10.8.0.2'},
    headers: {
        host:'marmitaria-api.onrender.com',
        'x-forwarded-proto':'https',
        'x-forwarded-for':'198.51.100.25, 203.0.113.48'
    }
};

test('Render requires no manually configured proxy IPs when platform identity is present', () => {
    const cfg = validateProductionEnvironment(renderEnv);
    assert.equal(cfg.proxyMode, 'render');
    assert.deepEqual(cfg.proxies, []);
    assert.equal(cfg.database, 'marmitaria');
    assert.equal(productionRequestAllowed(request,cfg), true);
    const app = {locals:{}, settings:{}, set(k,v){this.settings[k]=v;}, use(fn){this.middleware=fn;}};
    configureProductionProxy(app,cfg);
    assert.equal(app.settings['trust proxy'],1);
});

test('Render mode fails closed without platform identity', () => {
    for (const changes of [
        {RENDER:undefined},
        {RENDER_SERVICE_TYPE:'worker'},
        {RENDER_EXTERNAL_URL:'https://evil.example.com'},
        {INFINITEPAY_BIND_HOST:'127.0.0.1'}
    ]) {
        const env = {...renderEnv,...changes};
        assert.throws(() => validateProductionEnvironment(env), {code:'INFINITEPAY_PRODUCTION_BLOCKED'});
    }
});

test('Render requests still require correct origin and HTTPS forwarding', () => {
    const cfg=validateProductionEnvironment(renderEnv);
    for (const headers of [
        {...request.headers,host:'attacker.example.com'},
        {...request.headers,'x-forwarded-proto':'http'},
        {...request.headers,'x-forwarded-for':'not-an-ip'},
        {...request.headers,'x-forwarded-for':'198.51.100.25, spoofed'},
        {...request.headers,forwarded:'for=198.51.100.25'}
    ]) {
        assert.equal(productionRequestAllowed({...request,headers},cfg),false);
    }
});

test('unknown non-Render deployments still require explicit trusted proxy addresses', () => {
    const env={...renderEnv,RENDER:'false',INFINITEPAY_TRUSTED_PROXY_IPS:'192.0.2.42'};
    const cfg=validateProductionEnvironment(env);
    assert.equal(cfg.proxyMode,'allowlist');
    assert.equal(productionRequestAllowed({...request,socket:{remoteAddress:'192.0.2.42'}},cfg),true);
    assert.equal(productionRequestAllowed(request,cfg),false);
});
