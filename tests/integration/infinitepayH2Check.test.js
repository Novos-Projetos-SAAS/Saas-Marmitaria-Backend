import { describe, test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { executeH1SingleLink } from '../../src/homologation/infinitepayH1SingleLink.js';
import { encryptH1Observation, decryptH1Observation } from '../../src/homologation/infinitepayH1.js';

const apiKey = 'SYNTHETIC_H2_KEY_NEVER_EXPOSE', publicOrigin = 'https://synthetic-h2.trycloudflare.com';
const documented = { success: true, paid: true, amount: 100, paid_amount: 100, installments: 1, capture_method: 'pix' };
const response = data => new Response(JSON.stringify(data), { status: 200 });

describe('H2 one independent check, observation only, synthetic provider', { concurrency: false }, () => {
    let module, fixture, db, captureKey, previous, payment, original, bodies;
    before(async () => { module = await import('../../src/homologation/infinitepayH2Check.js'); });
    beforeEach(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest(); captureKey = randomBytes(32);
        previous = { keys: process.env.INFINITEPAY_ENCRYPTION_KEYS, version: process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION };
        process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: captureKey.toString('base64') });
        process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
        await executeH1SingleLink({ db, captureKey, publicOrigin, handle: 'matheuszxp', apiKey,
            transport: async () => response({ url: 'https://checkout.infinitepay.io/SYNTHETIC_PRIVATE_CHECKOUT' }) });
        payment = await db('pagamentos').first();
        const marker = await db('pagamentos_eventos').where({ event_key: 'h1:links:command-reservation' }).first();
        original = JSON.parse(decryptH1Observation(marker.payload_filtrado, captureKey).body);
        const base = { order_nsu: payment.order_nsu, invoice_slug: 'SYNTHETIC_PRIVATE_INVOICE', amount: 100, items: original.items };
        const paid = { ...base, event_type: 'paid', transaction_nsu: 'SYNTHETIC_PRIVATE_TRANSACTION', paid_amount: 100,
            capture_method: 'pix', installments: 1, receipt_url: 'https://recibo.infinitepay.io/SYNTHETIC_PRIVATE_RECEIPT' };
        bodies = [{ ...base, event_type: 'created' }, { ...base, event_type: 'settled' }, paid,
            { r: new URL(original.redirect_url).searchParams.get('r'), order_nsu: payment.order_nsu, transaction_nsu: paid.transaction_nsu,
                slug: base.invoice_slug, receipt_url: paid.receipt_url, capture_method: 'pix', transaction_id: 'SYNTHETIC_OTHER_ID' }];
        for (let i = 0; i < 4; i++) await db('pagamentos_eventos').insert({ id: 26 + i, event_key: 'h2:fixture:' + i,
            tipo_evento: i < 3 ? 'H1_OBSERVACAO_WEBHOOK' : 'H1_OBSERVACAO_RETURN', status_processamento: 'PENDENTE_IDENTIFICACAO',
            payload_filtrado: encryptH1Observation({ body: JSON.stringify(bodies[i]), headers: { 'x-provider-signature': 'SYNTHETIC_PRIVATE_HEADER' } }, captureKey) });
    });
    afterEach(async () => {
        if (fixture) await fixture.close();
        if (previous) for (const [field, name] of [['keys', 'INFINITEPAY_ENCRYPTION_KEYS'], ['version', 'INFINITEPAY_ENCRYPTION_KEY_VERSION']]) {
            if (previous[field] === undefined) delete process.env[name]; else process.env[name] = previous[field];
        }
    });
    const options = extra => ({ db, captureKey, apiKey, ...extra });
    async function change(index, update) {
        await db('pagamentos_eventos').where({ id: 26 + index }).update({
            payload_filtrado: encryptH1Observation({ body: JSON.stringify({ ...bodies[index], ...update }), headers: {} }, captureKey) });
    }
    test('read-only inspection correlates all evidence without treating the settled-before-paid webhook as approval', async () => {
        const before = await db('pagamentos_eventos').orderBy('id');
        const proof = await module.inspectH2Check(options());
        assert.equal(proof.ready, true); assert.equal(proof.identifiers_consistent, true); assert.equal(proof.read_only, true);
        assert.deepEqual(proof.observed_events, ['created', 'settled', 'paid', 'RETURN']);
        assert.equal(proof.financial_confirmation, false); assert.equal(proof.amount_expected_centavos, 100);
        assert.equal(proof.observed_capture_method, 'pix'); assert.equal(proof.return_nonce_matches, true);
        assert.doesNotMatch(JSON.stringify(proof), /SYNTHETIC_PRIVATE|SYNTHETIC_H2_KEY|H1-MARMITARIA/);
        assert.deepEqual(await db('pagamentos_eventos').orderBy('id'), before);
    });
    test('one authenticated payment_check is durably captured and confirms only the observation, with no financial writes', async () => {
        const originalEvents = await db('pagamentos_eventos').orderBy('id');
        const orderBefore = await db('pedidos').first(), paymentBefore = await db('pagamentos').first();
        let calls = 0;
        const result = await module.executeH2Check(options({ transport: async (url, init) => {
            calls++; assert.equal(url, 'https://api.checkout.infinitepay.io/payment_check');
            assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['X-Api-Key'], apiKey);
            assert.deepEqual(JSON.parse(init.body), { handle: 'matheuszxp', order_nsu: payment.order_nsu,
                transaction_nsu: bodies[2].transaction_nsu, slug: bodies[2].invoice_slug });
            assert.equal(await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:dispatch-reservation' }).count('* as n').first().then(row => Number(row.n)), 1);
            return response(documented);
        } }));
        assert.equal(calls, 1); assert.equal(result.payment_confirmed, true); assert.equal(result.http_status, 200);
        assert.equal(result.amount_centavos, 100); assert.equal(result.paid_amount_centavos, 100);
        assert.equal(result.capture_method, 'pix'); assert.equal(result.installments, 1);
        assert.equal(result.response_echoed_identifiers, false); assert.equal(result.operational_transition_applied, false);
        assert.equal(result.attempt_status, 'INCERTA'); assert.equal(result.automatic_retry, false);
        assert.deepEqual(await db('pagamentos').first(), paymentBefore); assert.deepEqual(await db('pedidos').first(), orderBefore);
        for (const row of originalEvents) assert.deepEqual(await db('pagamentos_eventos').where({ id: row.id }).first(), row);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
        const capture = await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:response' }).first();
        assert.equal(capture.pagamento_id, payment.id);
        assert.equal(decryptH1Observation(capture.payload_filtrado, captureKey).body, JSON.stringify(documented));
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_H2_KEY|H1-MARMITARIA/);
    });
    test('paid_amount is independent of amount and may include payer fees', async () => {
        const result = await module.executeH2Check(options({ transport: async () => response({ ...documented, paid_amount: 110 }) }));
        assert.equal(result.payment_confirmed, true); assert.equal(result.amount_centavos, 100); assert.equal(result.paid_amount_centavos, 110);
        assert.equal(result.paid_amount_matches_webhook, false);
    });
    test('concurrent checks and a fresh service invocation cannot dispatch a second real query', async () => {
        let calls = 0;
        const transport = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 60)); return response(documented); };
        await Promise.all(Array.from({ length: 5 }, () => module.executeH2Check(options({ transport }))));
        const repeated = await module.executeH2Check(options({ transport: async () => { throw new Error('SECOND_REQUEST_FORBIDDEN'); } }));
        assert.equal(calls, 1); assert.equal(repeated.already_reserved, true); assert.equal(repeated.payment_confirmed, true);
    });
    test('timeout leaves a persistent consumed reservation with no retry or operational changes', async () => {
        let calls = 0;
        const result = await module.executeH2Check(options({ timeoutMs: 25, transport: async () => { calls++; return new Promise(() => {}); } }));
        assert.equal(result.payment_confirmed, false); assert.equal(result.response_received, false); assert.equal(result.attempt_status, 'INCERTA');
        const repeated = await module.executeH2Check(options({ transport: async () => { calls++; return response(documented); } }));
        assert.equal(calls, 1); assert.equal(repeated.already_reserved, true);
    });
    test('a response arriving after timeout cannot be captured or treated as a completed query', async () => {
        let calls = 0;
        const result = await module.executeH2Check(options({ timeoutMs: 20, transport: async () => {
            calls++; await new Promise(resolve => setTimeout(resolve, 80)); return response(documented);
        } }));
        assert.equal(result.payment_confirmed, false);
        await new Promise(resolve => setTimeout(resolve, 120));
        const after = await module.readH2CheckResult(options());
        assert.equal(calls, 1); assert.equal(after.response_received, false); assert.equal(after.attempt_status, 'INCERTA');
    });
    for (const [label, transport] of [['oversized body', async () => new Response('X'.repeat(65537), { status: 200 })],
        ['stream error', async () => new Response(new ReadableStream({ start(controller) {
            controller.error(new Error('SYNTHETIC_PRIVATE_STREAM_FAILURE'));
        } }), { status: 200 })]]) {
        test('incomplete response blocks and preserves its consumed reservation: ' + label, async () => {
            let calls = 0;
            const result = await module.executeH2Check(options({ transport: async (...args) => { calls++; return transport(...args); } }));
            assert.equal(result.payment_confirmed, false); assert.equal(result.response_received, false);
            await module.executeH2Check(options({ transport: async () => { calls++; return response(documented); } }));
            assert.equal(calls, 1); assert.equal((await db('pagamentos').first()).status, 'INCERTA');
            assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
        });
    }
    test('a crash after reservation and before transport can never reclaim the one-shot check', async () => {
        await db('pagamentos_eventos').insert({ event_key: 'h2:payment-check:dispatch-reservation', tipo_evento: 'H2_RESERVA_PAYMENT_CHECK',
            pagamento_id: payment.id, payload_filtrado: encryptH1Observation({ abandoned: true }, captureKey) });
        let calls = 0;
        const result = await module.executeH2Check(options({ transport: async () => { calls++; return response(documented); } }));
        assert.equal(calls, 0); assert.equal(result.payment_confirmed, false); assert.equal(result.response_received, false);
    });
    for (const [label, index, update] of [['order', 0, { order_nsu: 'OTHER' }], ['invoice', 1, { invoice_slug: 'OTHER' }],
        ['transaction', 3, { transaction_nsu: 'OTHER' }], ['nonce', 3, { r: 'OTHER' }], ['receipt', 3, { receipt_url: 'https://recibo.infinitepay.io/OTHER' }],
        ['blank', 2, { transaction_nsu: '   ' }], ['amount', 2, { amount: 101 }], ['method', 3, { capture_method: 'credit_card' }]]) {
        test('inconsistent ' + label + ' blocks before reserving or sending a query', async () => {
            await change(index, update); let calls = 0;
            await assert.rejects(module.executeH2Check(options({ transport: async () => { calls++; return response(documented); } })));
            assert.equal(calls, 0);
            assert.equal(await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:dispatch-reservation' }).first(), undefined);
        });
    }
    for (const [label, data, reason] of [['not paid', { ...documented, paid: false }, 'H2_PAYMENT_NOT_CONFIRMED'],
        ['success false', { ...documented, success: false }, 'H2_SUCCESS_NOT_TRUE'], ['wrong base amount', { ...documented, amount: 101 }, 'H2_AMOUNT_MISMATCH'],
        ['wrong method', { ...documented, capture_method: 'credit_card' }, 'H2_METHOD_MISMATCH'],
        ['wrong echo', { ...documented, transaction_nsu: 'OTHER' }, 'H2_RESPONSE_IDENTIFIERS_MISMATCH']]) {
        test('negative or incompatible response: ' + label, async () => {
            const result = await module.executeH2Check(options({ transport: async () => response(data) }));
            assert.equal(result.payment_confirmed, false); assert.equal(result.block_reason, reason);
            assert.equal(result.attempt_status, 'INCERTA'); assert.equal(result.operational_transition_applied, false);
        });
    }
    test('wrong key or missing explicit transport cannot reserve or send', async () => {
        await assert.rejects(module.executeH2Check(options({ apiKey: 'WRONG_SYNTHETIC_KEY', transport: async () => response(documented) })));
        await assert.rejects(module.executeH2Check(options()));
        assert.equal(await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:dispatch-reservation' }).first(), undefined);
    });
    test('HTTP errors remain encrypted and never become proof', async () => {
        const result = await module.executeH2Check(options({ transport: async () => new Response('SYNTHETIC_PRIVATE_PROVIDER_ERROR', { status: 502 }) }));
        assert.equal(result.http_status, 502); assert.equal(result.payment_confirmed, false);
        assert.equal(result.block_reason, 'H2_HTTP_NOT_OK');
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_H2_KEY/);
    });
    for (const [label, body, reason] of [['malformed JSON', '{SYNTHETIC_PRIVATE', 'H2_RESPONSE_NOT_JSON'],
        ['missing paid', JSON.stringify({ success: true }), 'H2_RESPONSE_CONTRACT_INVALID'],
        ['wrong paid type', JSON.stringify({ ...documented, paid: 'true' }), 'H2_RESPONSE_CONTRACT_INVALID'],
        ['invalid paid amount', JSON.stringify({ ...documented, paid_amount: -1 }), 'H2_RESPONSE_CONTRACT_INVALID']]) {
        test('ambiguous response blocks: ' + label, async () => {
            const result = await module.executeH2Check(options({ transport: async () => new Response(body, { status: 200 }) }));
            assert.equal(result.payment_confirmed, false); assert.equal(result.block_reason, reason);
            assert.equal(result.attempt_status, 'INCERTA');
            assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
        });
    }
    test('an absent optional success flag is accepted without inventing it or echoing identifiers', async () => {
        const data = { ...documented }; delete data.success;
        const result = await module.executeH2Check(options({ transport: async () => response(data) }));
        assert.equal(result.payment_confirmed, true); assert.equal(Object.hasOwn(result, 'success'), false);
        assert.equal(result.response_echoed_identifiers, false);
    });
    test('unknown response values and credentials reflected as field names cannot leak in the summary', async () => {
        const data = { ...documented, [apiKey]: apiKey, private_context: { url: 'https://private.invalid/SYNTHETIC_PRIVATE', key: apiKey } };
        const result = await module.executeH2Check(options({ transport: async () => response(data) }));
        assert.equal(result.payment_confirmed, true); assert.ok(result.response_fields.includes('[PRIVATE_FIELD]'));
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_H2_KEY|private.invalid/);
    });
    test('tampering with the encrypted response binding is rejected without another request', async () => {
        await module.executeH2Check(options({ transport: async () => response(documented) }));
        const row = await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:response' }).first();
        const captured = decryptH1Observation(row.payload_filtrado, captureKey);
        await db('pagamentos_eventos').where({ id: row.id }).update({ payload_filtrado: encryptH1Observation({ ...captured, request_sha256: 'wrong' }, captureKey) });
        await assert.rejects(module.readH2CheckResult(options()), error => error.code === 'H2_RESPONSE_BINDING_MISMATCH');
    });
    test('the nonce in the original encrypted request must still match the attempt', async () => {
        const marker = await db('pagamentos_eventos').where({ event_key: 'h1:links:command-reservation' }).first();
        const source = decryptH1Observation(marker.payload_filtrado, captureKey);
        const changed = { ...original, redirect_url: publicOrigin + '/pagamentos/infinitepay/retorno?r=WRONG' };
        await db('pagamentos_eventos').where({ id: marker.id }).update({ payload_filtrado: encryptH1Observation({ ...source, body: JSON.stringify(changed) }, captureKey) });
        await assert.rejects(module.inspectH2Check(options()));
    });
    test('failed response persistence does not approve and the committed reservation still prevents repeat', async () => {
        let calls = 0;
        const result = await module.executeH2Check(options({ transport: async () => {
            calls++;
            await db.raw(`CREATE FUNCTION deny_h2_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF NEW.event_key='h2:payment-check:response' THEN RAISE EXCEPTION 'SYNTHETIC_STORAGE_FAILURE'; END IF; RETURN NEW; END $$`);
            await db.raw('CREATE TRIGGER deny_h2_capture BEFORE INSERT ON pagamentos_eventos FOR EACH ROW EXECUTE FUNCTION deny_h2_capture()');
            return response(documented);
        } }));
        assert.equal(result.response_received, false); assert.equal(result.payment_confirmed, false);
        await module.executeH2Check(options({ transport: async () => { calls++; return response(documented); } }));
        assert.equal(calls, 1);
    });
});
