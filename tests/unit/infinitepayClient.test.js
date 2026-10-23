import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCheckoutPayload,
    checkoutValidUntil,
    createInfinitepayClient,
    InfinitepayClientError
} from '../../src/services/infinitepayClient.js';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const VALID_UNTIL = '2026-10-24T02:59:59.000Z';
const RETURN_URL = 'https://merchant.example.test/return?r=SYNTHETIC_RETURN_TOKEN';
const WEBHOOK_URL = 'https://merchant.example.test/webhook';

function input(overrides = {}) {
    return {
        orderNsu: 'ORDER-123-T1',
        items: [{ quantity: 2, price: 1590, description: 'Marmita' }],
        validUntil: VALID_UNTIL,
        redirectUrl: RETURN_URL,
        webhookUrl: WEBHOOK_URL,
        now: NOW,
        ...overrides
    };
}

function localFailure(error) {
    assert.ok(error instanceof InfinitepayClientError);
    assert.equal(error.outcome, 'FALHOU');
    assert.equal(typeof error.code, 'string');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /SYNTHETIC|RETURN_TOKEN|https:/);
    return true;
}

test('payload sends integer cents, documented options and webhook events with no extra fields', () => {
    assert.deepEqual(buildCheckoutPayload(input({ handle: 'ignored', discounts: [1] })), {
        order_nsu: 'ORDER-123-T1',
        items: [{ quantity: 2, price: 1590, description: 'Marmita' }],
        redirect_url: RETURN_URL,
        options: {
            assured_installments: 1,
            require_delivery_address: false,
            single_payment: true,
            valid_until: VALID_UNTIL,
            payment_methods_enabled: ['pix', 'credit_card']
        },
        webhook: {
            url: WEBHOOK_URL,
            events: ['created', 'paid', 'settled', 'payment_failed', 'canceled', 'refunded']
        }
    });
});

test('payload trims IDs and item descriptions while excluding untrusted item fields', () => {
    const payload = buildCheckoutPayload(input({
        orderNsu: ' ORDER-123-T1 ',
        items: [{ quantity: 1, price: 10, description: ' Marmita ', discount: 1 }]
    }));
    assert.equal(payload.order_nsu, 'ORDER-123-T1');
    assert.deepEqual(payload.items, [{ quantity: 1, price: 10, description: 'Marmita' }]);
});

for (const [label, overrides] of [
    ['null ID', { orderNsu: null }],
    ['missing ID', { orderNsu: undefined }],
    ['blank ID', { orderNsu: '  ' }],
    ['control character in ID', { orderNsu: 'ORDER\n123' }],
    ['empty item list', { items: [] }],
    ['null items', { items: null }],
    ['zero quantity', { items: [{ quantity: 0, price: 1, description: 'x' }] }],
    ['fractional quantity', { items: [{ quantity: 1.5, price: 1, description: 'x' }] }],
    ['fractional cents', { items: [{ quantity: 1, price: 1.99, description: 'x' }] }],
    ['negative price', { items: [{ quantity: 1, price: -1, description: 'x' }] }],
    ['unsafe price', { items: [{ quantity: 1, price: Number.MAX_SAFE_INTEGER + 1, description: 'x' }] }],
    ['blank description', { items: [{ quantity: 1, price: 1, description: ' ' }] }],
    ['unsafe line total', { items: [{ quantity: 2, price: Number.MAX_SAFE_INTEGER, description: 'x' }] }],
    ['unsafe order total', { items: [{ quantity: 1, price: Number.MAX_SAFE_INTEGER, description: 'x' }, { quantity: 1, price: 1, description: 'y' }] }],
    ['null installments', { assuredInstallments: null }],
    ['negative installments', { assuredInstallments: -1 }],
    ['excess installments', { assuredInstallments: 13 }],
    ['fractional installments', { assuredInstallments: 1.5 }],
    ['HTTP return URL', { redirectUrl: 'http://merchant.example.test/return' }],
    ['return URL userinfo', { redirectUrl: 'https://SYNTHETIC:SECRET@merchant.example.test/return' }],
    ['empty return URL userinfo', { redirectUrl: 'https://@merchant.example.test/return' }],
    ['return URL fragment', { redirectUrl: RETURN_URL + '#token' }],
    ['webhook fragment', { webhookUrl: WEBHOOK_URL + '#' }],
    ['webhook userinfo', { webhookUrl: 'https://SYNTHETIC@merchant.example.test/webhook' }],
    ['wrong expiry day', { validUntil: '2026-10-25T02:59:59.000Z' }],
    ['wrong expiry second', { validUntil: '2026-10-24T02:59:58.000Z' }],
    ['expiry without zone', { validUntil: '2026-10-23T23:59:59' }]
]) {
    test('payload rejects ' + label + ' with a sanitized local error', () => {
        assert.throws(() => buildCheckoutPayload(input(overrides)), localFailure);
    });
}

test('payload accepts both documented installment boundaries', () => {
    assert.equal(buildCheckoutPayload(input({ assuredInstallments: 0 })).options.assured_installments, 0);
    assert.equal(buildCheckoutPayload(input({ assuredInstallments: 12 })).options.assured_installments, 12);
});

test('customer is omitted unless the buyer supplied supported data', () => {
    assert.equal(Object.hasOwn(buildCheckoutPayload(input()), 'customer'), false);
    assert.equal(Object.hasOwn(buildCheckoutPayload(input({ customer: {} })), 'customer'), false);
    assert.deepEqual(buildCheckoutPayload(input({ customer: { name: ' Cliente ', email: ' cliente@example.test ', phone_number: '+5511999999999', document: 'ignored' } })).customer, {
        name: 'Cliente', email: 'cliente@example.test', phone_number: '+5511999999999'
    });
    assert.deepEqual(buildCheckoutPayload(input({ customer: { name: 'Cliente' } })).customer, { name: 'Cliente' });
});

for (const customer of [null, [], { name: null }, { name: ' ' }, { name: 123 }, { name: 'SYNTHETIC\nNAME' }, { email: '' }, { email: 'invalid' }, { phone_number: '123' }]) {
    test('customer rejects malformed supplied values: ' + JSON.stringify(customer), () => {
        assert.throws(() => buildCheckoutPayload(input({ customer })), localFailure);
    });
}

for (const [instant, expected] of [
    ['2026-10-23T02:59:58.000Z', '2026-10-23T02:59:59.000Z'],
    ['2026-10-23T03:00:00.000Z', '2026-10-24T02:59:59.000Z'],
    ['2018-11-03T12:00:00.000Z', '2018-11-04T02:59:59.000Z'],
    ['2018-11-04T12:00:00.000Z', '2018-11-05T01:59:59.000Z']
]) {
    test('IANA São Paulo end of day for ' + instant, () => {
        assert.equal(checkoutValidUntil(new Date(instant)), expected);
    });
}

test('end of day rejects invalid dates and an instant at or after its expiry second', () => {
    for (const date of [new Date('invalid'), new Date('2026-10-24T02:59:59.000Z'), new Date('2026-10-24T02:59:59.500Z')]) {
        assert.throws(() => checkoutValidUntil(date), localFailure);
    }
});

test('expiry with the correct explicit IANA offset is normalized to ISO UTC', () => {
    const payload = buildCheckoutPayload(input({
        now: new Date('2018-11-04T12:00:00.000Z'),
        validUntil: '2018-11-04T23:59:59-02:00'
    }));
    assert.equal(payload.options.valid_until, '2018-11-05T01:59:59.000Z');
});

test('payload rejects a sparse item list instead of serializing empty slots as null', () => {
    assert.throws(() => buildCheckoutPayload(input({ items: new Array(2) })), localFailure);
});

const API_KEY = 'SYNTHETIC_API_KEY_DO_NOT_EXPOSE';
const CHECKOUT_ORIGIN = 'https://checkout.example.test';
const CREATED_URL = CHECKOUT_ORIGIN + '/pay/SYNTHETIC_LINK?token=SYNTHETIC_CHECKOUT_TOKEN';
const DATA = { syntheticContract: { destination: CREATED_URL, reference: 'invoice-123' } };

function response(data = DATA, status = 201) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// This is an intentionally synthetic contract adapter, not a provider JSON schema.
function parseSyntheticContract(data) {
    return { checkoutUrl: data.syntheticContract.destination, invoiceSlug: data.syntheticContract.reference };
}

function client(overrides = {}) {
    return createInfinitepayClient({
        transport: async () => response(),
        parseCreatedLink: parseSyntheticContract,
        checkoutOrigins: [CHECKOUT_ORIGIN],
        now: () => NOW,
        ...overrides
    });
}

function request(overrides = {}) {
    return { apiKey: API_KEY, payload: buildCheckoutPayload(input()), ...overrides };
}

function uncertainFailure(error) {
    assert.ok(error instanceof InfinitepayClientError);
    assert.equal(error.outcome, 'INCERTA');
    assert.equal(typeof error.code, 'string');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error) + String(error) + error.stack, /SYNTHETIC|https:\/\//);
    assert.equal(Object.hasOwn(error, 'response'), false);
    assert.equal(Object.hasOwn(error, 'body'), false);
    return true;
}

test('client sends one authenticated POST and returns only explicitly adapted fields', async () => {
    const calls = [];
    const service = client({
        transport: async (url, init) => {
            calls.push({ url, init });
            return response();
        },
        parseCreatedLink: data => ({ ...parseSyntheticContract(data), apiKey: API_KEY, raw: DATA })
    });
    assert.deepEqual(await service.createCheckout(request()), { checkoutUrl: CREATED_URL, invoiceSlug: 'invoice-123' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.checkout.infinitepay.io/links');
    assert.equal(url.includes(API_KEY), false);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY });
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, buildCheckoutPayload(input()));
    assert.equal(init.body.includes(API_KEY), false);
    assert.equal(Object.hasOwn(body, 'handle'), false);
});

test('client supports a parser result without an invoice slug', async () => {
    assert.deepEqual(await client({ parseCreatedLink: () => ({ checkoutUrl: CREATED_URL }) }).createCheckout(request()), { checkoutUrl: CREATED_URL });
});

test('an explicitly undefined optional invoice slug is omitted from the result', async () => {
    assert.deepEqual(await client({ parseCreatedLink: () => ({ checkoutUrl: CREATED_URL, invoiceSlug: undefined }) }).createCheckout(request()), { checkoutUrl: CREATED_URL });
});

test('invalid client configuration has a sanitized local error even when a getter throws', () => {
    assert.throws(() => createInfinitepayClient(null), localFailure);
    assert.throws(() => createInfinitepayClient({ get transport() { throw new Error(API_KEY + RETURN_URL); } }), localFailure);
});

test('missing transport cannot fall back to global fetch', async t => {
    const originalFetch = globalThis.fetch;
    let externalCalls = 0;
    globalThis.fetch = async () => { externalCalls += 1; throw new Error('Forbidden real transport'); };
    t.after(() => { globalThis.fetch = originalFetch; });
    await assert.rejects(client({ transport: undefined }).createCheckout(request()), localFailure);
    assert.equal(externalCalls, 0);
});

for (const [label, configuration] of [
    ['missing contract parser', { parseCreatedLink: undefined }],
    ['invalid contract parser', { parseCreatedLink: 'SYNTHETIC_PARSER' }],
    ['empty checkout allowlist', { checkoutOrigins: [] }],
    ['HTTP checkout origin', { checkoutOrigins: ['http://checkout.example.test'] }],
    ['origin with path', { checkoutOrigins: [CHECKOUT_ORIGIN + '/path'] }],
    ['origin with userinfo', { checkoutOrigins: ['https://SYNTHETIC@checkout.example.test'] }],
    ['zero timeout', { timeoutMs: 0 }],
    ['invalid timeout', { timeoutMs: Number.NaN }],
    ['overflow timeout', { timeoutMs: 2147483648 }]
]) {
    test('client blocks before any request for ' + label, async () => {
        let calls = 0;
        const service = client({ transport: async () => { calls += 1; return response(); }, ...configuration });
        await assert.rejects(service.createCheckout(request()), localFailure);
        assert.equal(calls, 0);
    });
}

for (const [label, apiKey] of [['missing key', undefined], ['empty key', ' '], ['header injection', API_KEY + '\r\nX-Injected: true']]) {
    test('client rejects ' + label + ' before any request', async () => {
        let calls = 0;
        const service = client({ transport: async () => { calls += 1; return response(); } });
        await assert.rejects(service.createCheckout(request({ apiKey })), localFailure);
        assert.equal(calls, 0);
    });
}

test('client revalidates cents immediately before sending a mutable payload', async () => {
    let calls = 0;
    const payload = buildCheckoutPayload(input());
    payload.items[0].price = 0.01;
    await assert.rejects(client({ transport: async () => { calls += 1; return response(); } }).createCheckout(request({ payload })), localFailure);
    assert.equal(calls, 0);
});

test('client rebuilds the allowlisted payload instead of sending unsafe caller options', async () => {
    let sent;
    const payload = buildCheckoutPayload(input());
    payload.handle = 'SYNTHETIC_HANDLE';
    payload.discounts = ['SYNTHETIC_DISCOUNT'];
    payload.options.single_payment = false;
    payload.options.require_delivery_address = true;
    payload.options.payment_methods_enabled = ['unknown'];
    await client({ transport: async (_url, init) => { sent = JSON.parse(init.body); return response(); } }).createCheckout(request({ payload }));
    assert.deepEqual(sent, buildCheckoutPayload(input()));
});

test('client rejects an expiry that elapsed after payload construction', async () => {
    let calls = 0;
    const service = client({ now: () => new Date(VALID_UNTIL), transport: async () => { calls += 1; return response(); } });
    await assert.rejects(service.createCheckout(request()), localFailure);
    assert.equal(calls, 0);
});

test('client rejects a prior-day expiry after São Paulo midnight', async () => {
    let calls = 0;
    const service = client({ now: () => new Date('2026-10-24T03:00:00.000Z'), transport: async () => { calls += 1; return response(); } });
    await assert.rejects(service.createCheckout(request()), localFailure);
    assert.equal(calls, 0);
});

for (const status of [301, 302, 307, 400, 401, 429, 500]) {
    test('HTTP ' + status + ' is uncertain with one request and no response-body disclosure', async () => {
        let calls = 0;
        let reads = 0;
        await assert.rejects(client({ transport: async () => {
            calls += 1;
            return { status, json: async () => { reads += 1; return { secret: API_KEY, url: RETURN_URL }; } };
        } }).createCheckout(request()), uncertainFailure);
        assert.equal(calls, 1);
        assert.equal(reads, 0);
    });
}

test('network rejection is uncertain and never retried or exposed', async () => {
    let calls = 0;
    await assert.rejects(client({ transport: async () => { calls += 1; throw new Error(API_KEY + ' ' + RETURN_URL); } }).createCheckout(request()), uncertainFailure);
    assert.equal(calls, 1);
});

test('synchronous transport failure is uncertain and never retried', async () => {
    let calls = 0;
    await assert.rejects(client({ transport: () => { calls += 1; throw new Error(API_KEY); } }).createCheckout(request()), uncertainFailure);
    assert.equal(calls, 1);
});

test('invalid response JSON is uncertain and does not assume a provider schema', async () => {
    let calls = 0;
    await assert.rejects(client({ transport: async () => { calls += 1; return new Response(API_KEY + RETURN_URL, { status: 201 }); } }).createCheckout(request()), uncertainFailure);
    assert.equal(calls, 1);
});

test('adapter failure is uncertain and does not expose its original error', async () => {
    await assert.rejects(client({ parseCreatedLink: () => { throw new Error(API_KEY + RETURN_URL); } }).createCheckout(request()), uncertainFailure);
});

for (const [label, parsed] of [
    ['missing adapted data', null],
    ['missing checkout URL', {}],
    ['HTTP URL', { checkoutUrl: 'http://checkout.example.test/pay' }],
    ['another origin', { checkoutUrl: 'https://untrusted.example.test/pay?token=SYNTHETIC' }],
    ['origin prefix trick', { checkoutUrl: 'https://checkout.example.test.evil.test/pay' }],
    ['different port', { checkoutUrl: 'https://checkout.example.test:444/pay' }],
    ['userinfo', { checkoutUrl: 'https://SYNTHETIC:SECRET@checkout.example.test/pay' }],
    ['empty userinfo', { checkoutUrl: 'https://@checkout.example.test/pay' }],
    ['fragment', { checkoutUrl: CREATED_URL + '#SYNTHETIC' }],
    ['backslash URL', { checkoutUrl: 'https://checkout.example.test\\@evil.example.test/pay' }],
    ['blank invoice slug', { checkoutUrl: CREATED_URL, invoiceSlug: ' ' }],
    ['control character in invoice slug', { checkoutUrl: CREATED_URL, invoiceSlug: 'SYNTHETIC\nSLUG' }]
]) {
    test('malformed adapted ' + label + ' is uncertain after sending', async () => {
        await assert.rejects(client({ parseCreatedLink: () => parsed }).createCheckout(request()), uncertainFailure);
    });
}

test('timeout bounds a transport that ignores abort and never returns headers', async () => {
    let calls = 0;
    let signal;
    await assert.rejects(client({ timeoutMs: 10, transport: (_url, init) => {
        calls += 1;
        signal = init.signal;
        return new Promise(() => {});
    } }).createCheckout(request()), error => {
        uncertainFailure(error);
        assert.equal(error.code, 'INFINITEPAY_TIMEOUT');
        return true;
    });
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
});

test('timeout also bounds a response body that never settles', async () => {
    let signal;
    await assert.rejects(client({ timeoutMs: 10, transport: async (_url, init) => {
        signal = init.signal;
        return { status: 201, json: () => new Promise(() => {}) };
    } }).createCheckout(request()), error => {
        uncertainFailure(error);
        assert.equal(error.code, 'INFINITEPAY_TIMEOUT');
        return true;
    });
    assert.equal(signal.aborted, true);
});

test('late headers after timeout cannot trigger parsing or a second request', async () => {
    let finish;
    let calls = 0;
    let parses = 0;
    const pending = client({ timeoutMs: 10, transport: () => {
        calls += 1;
        return new Promise(resolve => { finish = resolve; });
    }, parseCreatedLink: () => { parses += 1; return { checkoutUrl: CREATED_URL }; } }).createCheckout(request());
    await assert.rejects(pending, uncertainFailure);
    finish(response());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(parses, 0);
});

test('late body after timeout is ignored before contract parsing', async () => {
    let finish;
    let parses = 0;
    const pending = client({ timeoutMs: 10, transport: async () => ({
        status: 201,
        json: () => new Promise(resolve => { finish = resolve; })
    }), parseCreatedLink: () => { parses += 1; return { checkoutUrl: CREATED_URL }; } }).createCheckout(request());
    await assert.rejects(pending, uncertainFailure);
    finish(DATA);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(parses, 0);
});

test('late body rejection after timeout is handled without an unhandled rejection', async () => {
    let rejectBody;
    const pending = client({ timeoutMs: 10, transport: async () => ({
        status: 201,
        json: () => new Promise((_resolve, reject) => { rejectBody = reject; })
    }) }).createCheckout(request());
    await assert.rejects(pending, uncertainFailure);
    rejectBody(new Error(API_KEY + RETURN_URL));
    await new Promise(resolve => setImmediate(resolve));
});

test('client blocks expiry that occurs during final payload preparation', async () => {
    let calls = 0;
    let clockReads = 0;
    await assert.rejects(client({
        now: () => ++clockReads === 1 ? NOW : new Date(VALID_UNTIL),
        transport: async () => { calls += 1; return response(); }
    }).createCheckout(request()), localFailure);
    assert.equal(calls, 0);
});

test('successful completion clears the abort timeout', async () => {
    let signal;
    await client({ timeoutMs: 10, transport: async (_url, init) => { signal = init.signal; return response(); } }).createCheckout(request());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(signal.aborted, false);
});

test('HTTP failure also clears the abort timeout', async () => {
    let signal;
    await assert.rejects(client({ timeoutMs: 10, transport: async (_url, init) => { signal = init.signal; return response({}, 500); } }).createCheckout(request()), uncertainFailure);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(signal.aborted, false);
});
