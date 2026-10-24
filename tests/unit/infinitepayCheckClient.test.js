import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInfinitepayCheckClient, InfinitepayCheckError } from '../../src/services/infinitepayCheckClient.js';
const API_KEY = 'SYNTHETIC_API_KEY_DO_NOT_EXPOSE';
const RECEIPT_ORIGIN = 'https://receipt.example.test';
const RECEIPT_URL = RECEIPT_ORIGIN + '/SYNTHETIC_RECEIPT?token=SYNTHETIC_TOKEN';
const DOCUMENTED = { success: true, paid: true, amount: 1500, paid_amount: 1510, installments: 1, capture_method: 'pix' };
const PAID = { paid: true, amount: 1500, paidAmount: 1510, installments: 1, captureMethod: 'pix' };

// Only the documented fields are mapped here. No echoed IDs or state contract is assumed.
function parseDocumented(data) {
    return { paid: data.paid, amount: data.amount, paidAmount: data.paid_amount,
        installments: data.installments, captureMethod: data.capture_method };
}

function request(overrides = {}) {
    return { apiKey: API_KEY, handle: 'merchant', orderNsu: 'ORDER-1-T1', transactionNsu: 'transaction-1', invoiceSlug: 'invoice-1', ...overrides };
}

function response(data = DOCUMENTED, status = 200) {
    return new Response(JSON.stringify(data), { status });
}

function client(overrides = {}) {
    return createInfinitepayCheckClient({ transport: async () => response(), parsePaymentCheck: parseDocumented, ...overrides });
}

function sanitized(error) {
    assert.ok(error instanceof InfinitepayCheckError);
    assert.match(error.code, /^INFINITEPAY_CHECK_(INVALID_INPUT|NOT_CONFIGURED|FAILED|TIMEOUT)$/);
    for (const key of ['cause', 'body', 'response', 'apiKey', 'raw']) assert.equal(Object.hasOwn(error, key), false);
    assert.doesNotMatch(JSON.stringify(error) + String(error) + error.stack, /SYNTHETIC|https:\/\//);
    return true;
}

test('exports a dedicated client and sanitized error', () => {
    assert.equal(typeof createInfinitepayCheckClient, 'function');
    assert.equal(typeof InfinitepayCheckError, 'function');
});

test('sends one authenticated POST with documented keys and returns only normalized fields', async () => {
    const calls = [];
    const result = await client({ transport: async (url, init) => { calls.push({ url, init }); return response(); },
        parsePaymentCheck: data => ({ ...parseDocumented(data), raw: data, apiKey: API_KEY }) }).checkPayment(request());
    assert.deepEqual(result, PAID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.checkout.infinitepay.io/payment_check');
    const { init } = calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY });
    assert.deepEqual(JSON.parse(init.body), { handle: 'merchant', order_nsu: 'ORDER-1-T1', transaction_nsu: 'transaction-1', slug: 'invoice-1' });
    assert.equal(init.body.includes(API_KEY), false);
});

test('paid false is valid without financial fields and HTTP success never means paid', async () => {
    assert.deepEqual(await client({ transport: async () => response({ paid: false }) }).checkPayment(request()), { paid: false });
    await assert.rejects(client({ transport: async () => response({ success: true }) }).checkPayment(request()), sanitized);
});

test('provider state and echoed identifiers are not inferred from raw response', async () => {
    assert.deepEqual(await client({ transport: async () => response({ ...DOCUMENTED, status: 'refunded', financialState: 'ESTORNADA', receipt_url: RECEIPT_URL,
        order_nsu: 'different', transaction_nsu: 'different', slug: 'different' }) }).checkPayment(request()), PAID);
});

for (const paid of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
    test('rejects nonboolean paid ' + JSON.stringify(paid), async () => {
        await assert.rejects(client({ parsePaymentCheck: () => ({ ...PAID, paid }) }).checkPayment(request()), sanitized);
    });
}

for (const [field, values] of [
    ['amount', [undefined, null, 0, -1, 1.5, '1500', Number.MAX_SAFE_INTEGER + 1]],
    ['paidAmount', [undefined, null, -1, 1.5, '1510', Number.MAX_SAFE_INTEGER + 1]],
    ['installments', [undefined, null, 0, -1, 1.5, '1', 32768]],
    ['captureMethod', [undefined, null, '', 'debit_card', 'PIX']]
]) {
    for (const value of values) test('rejects invalid paid ' + field + ': ' + JSON.stringify(value), async () => {
        await assert.rejects(client({ parsePaymentCheck: () => ({ ...PAID, [field]: value }) }).checkPayment(request()), sanitized);
    });
}

test('accepts financial boundaries and does not equate paidAmount with original amount', async () => {
    assert.deepEqual(await client({ parsePaymentCheck: () => ({ ...PAID, amount: Number.MAX_SAFE_INTEGER, paidAmount: 0, installments: 32767, captureMethod: 'credit_card' }) }).checkPayment(request()),
        { paid: true, amount: Number.MAX_SAFE_INTEGER, paidAmount: 0, installments: 32767, captureMethod: 'credit_card' });
});

for (const state of ['PAGA', 'LIQUIDADA', 'ESTORNADA']) {
    test('allows explicitly adapted independent state ' + state, async () => {
        // synthetic_state is a mock adapter contract, never a provider field assumption.
        const result = await client({ transport: async () => response({ ...DOCUMENTED, synthetic_state: state }),
            parsePaymentCheck: data => ({ ...parseDocumented(data), financialState: data.synthetic_state }) }).checkPayment(request());
        assert.deepEqual(result, { ...PAID, financialState: state });
    });
}

for (const financialState of [null, '', 'paid', 'CANCELADA', {}, true]) test('rejects invalid adapted financial state ' + JSON.stringify(financialState), async () => {
    await assert.rejects(client({ parsePaymentCheck: () => ({ ...PAID, financialState }) }).checkPayment(request()), sanitized);
});

test('compares complete adapted IDs against request without assuming UUID format', async () => {
    const identifiers = { orderNsu: 'ORDER-1-T1', transactionNsu: 'transaction-1', invoiceSlug: 'invoice-1' };
    const result = await client({ parsePaymentCheck: () => ({ ...PAID, identifiers: { ...identifiers, ignored: API_KEY } }) }).checkPayment(request());
    assert.deepEqual(result, { ...PAID, identifiers });
});

for (const identifiers of [null, [], {}, { orderNsu: 'ORDER-1-T1' },
    { orderNsu: 'wrong', transactionNsu: 'transaction-1', invoiceSlug: 'invoice-1' },
    { orderNsu: 'ORDER-1-T1', transactionNsu: 'wrong', invoiceSlug: 'invoice-1' },
    { orderNsu: 'ORDER-1-T1', transactionNsu: 'transaction-1', invoiceSlug: 'wrong' },
    { orderNsu: 'ORDER-1-T1', transactionNsu: 'transaction-1', invoiceSlug: ' ' }]) {
    test('blocks missing or mismatched adapted IDs ' + JSON.stringify(identifiers), async () => {
        await assert.rejects(client({ parsePaymentCheck: () => ({ ...PAID, identifiers }) }).checkPayment(request()), sanitized);
    });
}

test('returns a receipt only after paid true and exact configured HTTPS origin', async () => {
    assert.deepEqual(await client({ receiptOrigins: [RECEIPT_ORIGIN], parsePaymentCheck: () => ({ ...PAID, receiptUrl: RECEIPT_URL }) }).checkPayment(request()),
        { ...PAID, receiptUrl: RECEIPT_URL });
    await assert.rejects(client({ receiptOrigins: [RECEIPT_ORIGIN], parsePaymentCheck: () => ({ paid: false, receiptUrl: RECEIPT_URL }) }).checkPayment(request()), sanitized);
    await assert.rejects(client({ parsePaymentCheck: () => ({ ...PAID, receiptUrl: RECEIPT_URL }) }).checkPayment(request()), sanitized);
});

for (const receiptUrl of [null, '', 'http://receipt.example.test/x', 'https://evil.example.test/x',
    'https://receipt.example.test.evil.test/x', 'https://receipt.example.test:444/x',
    'https://SYNTHETIC:SECRET@receipt.example.test/x', 'https://@receipt.example.test/x',
    RECEIPT_URL + '#', RECEIPT_URL + '#SYNTHETIC', ' ' + RECEIPT_URL, RECEIPT_URL + '\n',
    'https://receipt.example.test\\@evil.example.test/x']) test('rejects untrusted receipt URL ' + JSON.stringify(receiptUrl), async () => {
    await assert.rejects(client({ receiptOrigins: [RECEIPT_ORIGIN], parsePaymentCheck: () => ({ ...PAID, receiptUrl }) }).checkPayment(request()), sanitized);
});

for (const [field, limit] of [['handle', 150], ['orderNsu', 120], ['transactionNsu', 255], ['invoiceSlug', 255]]) {
    for (const value of [undefined, null, '', ' ', 12, 'bad\nID', 'bad\u200bID', 'x'.repeat(limit + 1)]) {
        test('rejects invalid request ' + field + ': ' + JSON.stringify(value), async () => {
            let calls = 0;
            await assert.rejects(client({ transport: async () => { calls += 1; return response(); } }).checkPayment(request({ [field]: value })), sanitized);
            assert.equal(calls, 0);
        });
    }
    test('accepts schema maximum length for ' + field, async () => {
        await client().checkPayment(request({ [field]: 'x'.repeat(limit) }));
    });
}

test('trims request identifiers using existing client conventions', async () => {
    let body;
    await client({ transport: async (_url, init) => { body = JSON.parse(init.body); return response(); } }).checkPayment(request({ handle: ' merchant ', orderNsu: ' ORDER-1-T1 ' }));
    assert.equal(body.handle, 'merchant');
    assert.equal(body.order_nsu, 'ORDER-1-T1');
});

for (const apiKey of [undefined, null, '', ' ', ' ' + API_KEY, API_KEY + '\r\nX-Injected: true', 'nonasciiá', 'two words']) test('rejects unsafe credentials before transport ' + JSON.stringify(apiKey), async () => {
    let calls = 0;
    await assert.rejects(client({ transport: () => { calls += 1; } }).checkPayment(request({ apiKey })), sanitized);
    assert.equal(calls, 0);
});

test('never uses global fetch when transport is absent', async t => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls += 1; throw new Error(API_KEY); };
    t.after(() => { globalThis.fetch = original; });
    await assert.rejects(client({ transport: undefined }).checkPayment(request()), sanitized);
    assert.equal(calls, 0);
});

for (const configuration of [{ parsePaymentCheck: undefined }, { parsePaymentCheck: true }, { transport: true },
    { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { timeoutMs: 2147483648 },
    { receiptOrigins: null }, { receiptOrigins: ['http://receipt.example.test'] }, { receiptOrigins: [RECEIPT_ORIGIN + '/path'] },
    { receiptOrigins: ['https://SYNTHETIC@receipt.example.test'] }]) test('rejects unsafe configuration ' + JSON.stringify(configuration), async () => {
    let calls = 0;
    await assert.rejects(client({ transport: () => { calls += 1; }, ...configuration }).checkPayment(request()), sanitized);
    assert.equal(calls, 0);
});

test('sanitizes configuration and request getters and custom error codes', async () => {
    assert.throws(() => createInfinitepayCheckClient(null), sanitized);
    assert.throws(() => createInfinitepayCheckClient({ get transport() { throw new Error(API_KEY); } }), sanitized);
    await assert.rejects(client().checkPayment({ get apiKey() { throw new Error(API_KEY); } }), sanitized);
    sanitized(new InfinitepayCheckError(API_KEY));
});

for (const status of [undefined, '200', 199, 301, 302, 307, 400, 401, 429, 500]) test('rejects HTTP status without reading body: ' + status, async () => {
    let calls = 0;
    let reads = 0;
    await assert.rejects(client({ transport: () => { calls += 1; return { status, json: () => { reads += 1; return DOCUMENTED; } }; } }).checkPayment(request()), sanitized);
    assert.equal(calls, 1);
    assert.equal(reads, 0);
});

for (const [label, overrides] of [
    ['network rejection', { transport: async () => { throw new Error(API_KEY + RECEIPT_URL); } }],
    ['synchronous transport rejection', { transport: () => { throw new Error(API_KEY); } }],
    ['null response', { transport: () => null }],
    ['invalid JSON', { transport: () => new Response(API_KEY) }],
    ['throwing parser', { parsePaymentCheck: () => { throw new Error(API_KEY + RECEIPT_URL); } }],
    ['rejected parser', { parsePaymentCheck: async () => { throw new Error(API_KEY); } }],
    ['null parsed data', { parsePaymentCheck: () => null }],
    ['array parsed data', { parsePaymentCheck: () => [] }],
    ['throwing parsed getter', { parsePaymentCheck: () => ({ get paid() { throw new Error(API_KEY); } }) }]
]) test('sanitizes ' + label, async () => {
    await assert.rejects(client(overrides).checkPayment(request()), sanitized);
});

for (const phase of ['headers', 'body', 'parser']) test('timeout covers unresponsive ' + phase + ' even ignoring abort', async () => {
    let signal;
    let calls = 0;
    const never = () => new Promise(() => {});
    await assert.rejects(client({ timeoutMs: 10, transport: (_url, init) => {
        calls += 1;
        signal = init.signal;
        if (phase === 'headers') return never();
        return { status: 200, json: phase === 'body' ? never : async () => DOCUMENTED };
    }, parsePaymentCheck: phase === 'parser' ? never : parseDocumented }).checkPayment(request()), error => {
        sanitized(error);
        assert.equal(error.code, 'INFINITEPAY_CHECK_TIMEOUT');
        return true;
    });
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
});

test('late headers and body are ignored before parsing after timeout', async () => {
    for (const phase of ['headers', 'body']) {
        let finish;
        let parses = 0;
        const pendingData = new Promise(resolve => { finish = resolve; });
        const pending = client({ timeoutMs: 10,
            transport: () => phase === 'headers' ? pendingData : { status: 200, json: () => pendingData },
            parsePaymentCheck: data => { parses += 1; return parseDocumented(data); } }).checkPayment(request());
        await assert.rejects(pending, sanitized);
        finish(phase === 'headers' ? response() : DOCUMENTED);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(parses, 0);
    }
});

test('successful and failed completion clear timeout without later abort', async () => {
    for (const status of [200, 500]) {
        let signal;
        const pending = client({ timeoutMs: 10, transport: (_url, init) => { signal = init.signal; return response(DOCUMENTED, status); } }).checkPayment(request());
        if (status === 200) await pending;
        else await assert.rejects(pending, sanitized);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(signal.aborted, false);
    }
});
