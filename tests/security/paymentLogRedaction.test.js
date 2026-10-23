import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../../src/utils/safeRequestLog.js';

test('request audit metadata excludes secrets, PII and untrusted URLs even with nested errors', () => {
    const sentinel = 'DO_NOT_LOG_FINANCIAL_SECRET';
    const record = security.safeRequestLog({
        method: 'PUT', originalUrl: '/configuracoes/infinitepay?ref=' + sentinel,
        baseUrl: '/configuracoes/infinitepay', route: { path: '/' }, usuario: { id: 7 },
        headers: { authorization: sentinel, cookie: sentinel, 'x-api-key': sentinel },
        body: { api_key: sentinel, nested: { password: sentinel } },
        query: { ref: sentinel }, params: { id: sentinel }
    }, Object.assign(new Error(sentinel), { code: sentinel, config: { headers: { key: sentinel } } }));
    assert.equal(JSON.stringify(record).includes(sentinel), false);
    assert.equal(record.method, 'PUT');
    assert.equal(record.route, '/configuracoes/infinitepay/');
    assert.equal(record.usuario_id, 7);
});

test('unknown paths and internal errors do not leak URL tokens or database messages', () => {
    const secret = 'HIDDEN_TOKEN';
    const record = security.safeRequestLog({ method: 'GET', originalUrl: '/secret/' + secret });
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.deepEqual(security.publicError(Object.assign(new Error(secret), { statusCode: 500 })),
        { status: 'error', message: 'Erro interno no servidor' });
});

test('pre-route failures retain only the server-owned audit prefix', () => {
    const sentinel = 'DO_NOT_LOG_PRE_ROUTE_SECRET';
    const record = security.safeRequestLog({
        method: 'GET', auditBase: '/configuracoes/infinitepay', usuario: { id: 7 },
        baseUrl: '/untrusted/' + sentinel,
        originalUrl: '/configuracoes/infinitepay?api_key=' + sentinel,
        url: '/?token=' + sentinel, headers: { authorization: sentinel }, body: { api_key: sentinel }
    });
    assert.deepEqual(record, { method: 'GET', route: '/configuracoes/infinitepay', usuario_id: 7 });
    assert.equal(JSON.stringify(record).includes(sentinel), false);
});

test('post-route failures prefer the static prefix over a restored or parameterized baseUrl', () => {
    const record = security.safeRequestLog({
        method: 'PUT', auditBase: '/configuracoes/infinitepay', baseUrl: '/HIDDEN_TOKEN',
        route: { path: '/' }, usuario: { id: 7 }, originalUrl: '/HIDDEN_TOKEN?key=HIDDEN_KEY'
    });
    assert.deepEqual(record, { method: 'PUT', route: '/configuracoes/infinitepay/', usuario_id: 7 });
});

test('a baseUrl without a known audit prefix or selected route is not logged', () => {
    const record = security.safeRequestLog({ method: 'GET', baseUrl: '/HIDDEN_TOKEN', path: '/HIDDEN_KEY' });
    assert.equal(record.route, '[unmatched]');
});

test('approved menu conflicts preserve their public code and whitelisted details', () => {
    const result = security.publicError(Object.assign(new Error('Produto alterado.'), {
        statusCode: 409, exposeDetails: true, code: 'PRODUTOS_ALTERADOS',
        details: { produtos: [{ id: 42, nome: 'Agua', preco_atual: 3, api_key: 'HIDDEN' }], api_key: 'HIDDEN' }
    }));
    assert.equal(result.code, 'PRODUTOS_ALTERADOS');
    assert.equal(result.message, 'Produto alterado.');
    assert.equal(JSON.stringify(result).includes('HIDDEN'), false);
    assert.equal(result.details.produtos[0].preco_atual, 3);
});
