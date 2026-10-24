import { describe, test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import knex from 'knex';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { createH1App, decryptH1Observation } from '../../src/homologation/infinitepayH1.js';

const publicOrigin = 'https://h1-synthetic.trycloudflare.com';
const handle = 'matheuszxp', apiKey = 'SYNTHETIC_H1_ONLY_NOT_A_REAL_KEY';
describe('operator-confirmed single H1 link, simulated provider only', { concurrency: false }, () => {
    let module, fixture, db, captureKey, previous;
    before(async () => { module = await import('../../src/homologation/infinitepayH1SingleLink.js'); });
    beforeEach(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest(); captureKey = randomBytes(32);
        previous = { keys: process.env.INFINITEPAY_ENCRYPTION_KEYS, version: process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION };
        process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: captureKey.toString('base64') });
        process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
    });
    afterEach(async () => {
        if (fixture) await fixture.close();
        if (previous) for (const [field, key] of [['keys', 'INFINITEPAY_ENCRYPTION_KEYS'], ['version', 'INFINITEPAY_ENCRYPTION_KEY_VERSION']]) {
            if (previous[field] === undefined) delete process.env[key]; else process.env[key] = previous[field];
        }
    });
    const options = extra => ({ db, captureKey, publicOrigin, handle, apiKey, ...extra });
    test('confirmation accepts only the exact typed phrase on an interactive terminal', async () => {
        for (const [answer, expected] of [['CRIAR H1 100 CENTAVOS', true], ['sim', false], ['', false], [' CRIAR H1 100 CENTAVOS', false]]) {
            const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true;
            let screen = ''; output.on('data', value => { screen += value; });
            const waiting = module.confirmH1Link({ input, output, publicOrigin });
            setImmediate(() => input.end(answer + '\n'));
            assert.equal(await waiting, expected);
            assert.ok(screen.includes('100 centavos'));
            assert.ok(screen.includes(publicOrigin + '/pagamentos/infinitepay/webhook'));
            assert.equal(screen.includes(apiKey), false);
        }
    });
    test('redirected input cannot provide an automatic confirmation', async () => {
        const input = new PassThrough(), output = new PassThrough(); input.isTTY = false; output.isTTY = true;
        await assert.rejects(module.confirmH1Link({ input, output, publicOrigin }));
        assert.equal(Number((await db('pagamentos').count('* as n').first()).n), 0);
    });
    test('preflight proves HTTPS routes reach this database using only synthetic events and returns', async () => {
        const server = createH1App({ db, captureKey, publicOrigin, log: () => {} }).listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        let providerCalls = 0;
        try {
            const transport = (url, init) => {
                if (url.startsWith('https://api.checkout.infinitepay.io')) { providerCalls++; throw new Error('financial preflight forbidden'); }
                const target = new URL(url);
                assert.equal(target.origin, publicOrigin);
                return fetch('http://127.0.0.1:' + server.address().port + target.pathname + target.search, init);
            };
            const proof = await module.verifyH1Endpoints({ db, publicOrigin, transport });
            assert.equal(proof.webhook_persisted, true); assert.equal(proof.correlated_return, true);
            assert.equal(providerCalls, 0);
            assert.equal(Number((await db('pagamentos_eventos').where({ event_key: 'h1:links:dispatch-budget' }).count('* as n').first()).n), 0);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
    test('one mock POST uses the existing orchestrator and preserves an unknown response without assuming its URL contract', async () => {
        let calls = 0;
        const transport = async (url, init) => {
            calls++; assert.equal(url, 'https://api.checkout.infinitepay.io/links');
            assert.equal(init.method, 'POST'); assert.equal(init.headers['X-Api-Key'], apiKey); assert.equal(init.redirect, 'error');
            const payload = JSON.parse(init.body);
            assert.equal(payload.handle, undefined);
            assert.match(payload.order_nsu, /^H1-MARMITARIA-\d+-T1-/);
            assert.equal(payload.items.length, 1); assert.equal(payload.items[0].quantity, 1); assert.equal(payload.items[0].price, 100);
            assert.equal(payload.options.single_payment, true); assert.equal(payload.options.require_delivery_address, false);
            assert.equal(payload.options.assured_installments, 1); assert.equal(payload.options.discounts, undefined);
            assert.deepEqual(payload.options.payment_methods_enabled, ['credit_card', 'pix']);
            assert.equal(payload.webhook.url, publicOrigin + '/pagamentos/infinitepay/webhook');
            const marker = await db('pagamentos_eventos').where({ event_key: 'h1:links:command-reservation' }).first();
            const payment = await db('pagamentos').where({ id: marker.pagamento_id }).first();
            assert.equal(payment.status, 'CRIANDO'); assert.equal(payment.handle_snapshot, handle);
            assert.equal(payment.credencial_id !== null, true);
            assert.equal(JSON.stringify(await db('infinitepay_credenciais').select('*')).includes(apiKey), false);
            assert.equal((await db('config_infinitepay').first()).ativo, false);
            const storedRequest = JSON.parse(decryptH1Observation(marker.payload_filtrado, captureKey).body);
            assert.equal(storedRequest.order_nsu, payload.order_nsu);
            assert.equal(createHash('sha256').update(new URL(storedRequest.redirect_url).searchParams.get('r')).digest('hex'), payment.return_nonce_hash);
            return new Response(JSON.stringify({ entirely_new_link_field: 'https://observed-untrusted.invalid.test/pay/PRIVATE_FINANCIAL_ID',
                invoice_id: 'PRIVATE_FINANCIAL_ID', api_key: apiKey, [apiKey]: 'private' }), { status: 201 });
        };
        const result = await module.executeH1SingleLink(options({ transport }));
        assert.equal(calls, 1); assert.equal(result.attempt_status, 'INCERTA'); assert.equal(result.http_status, 201);
        assert.equal(result.response_received, true); assert.equal(result.financial_confirmation, false);
        const visible = JSON.stringify(result);
        assert.equal(visible.includes(apiKey), false); assert.equal(visible.includes('PRIVATE_FINANCIAL_ID'), false);
        assert.ok(visible.includes('entirely_new_link_field')); assert.ok(visible.includes('https://observed-untrusted.invalid.test'));
        const repeated = await module.executeH1SingleLink(options({ transport }));
        assert.equal(repeated.already_reserved, true); assert.equal(calls, 1);
        for (const localKey of [undefined, 'SYNTHETIC_REPLACED_LOCAL_KEY']) {
            const viewed = await module.readH1LinkResult(options({ apiKey: localKey }));
            assert.equal(JSON.stringify(viewed).includes(apiKey), false);
        }
        const ring = process.env.INFINITEPAY_ENCRYPTION_KEYS;
        try {
            delete process.env.INFINITEPAY_ENCRYPTION_KEYS;
            const unavailable = await module.readH1LinkResult(options({ apiKey: undefined }));
            assert.equal(unavailable.http_status, 201);
            assert.equal(unavailable.json_structure, undefined);
            assert.equal(unavailable.details_blocked, 'CREDENTIAL_UNAVAILABLE');
            assert.equal(JSON.stringify(unavailable).includes(apiKey), false);
        } finally { process.env.INFINITEPAY_ENCRYPTION_KEYS = ring; }
        const payment = await db('pagamentos').first();
        assert.equal(payment.checkout_url, null);
        assert.equal((await db('pedidos').where({ id: payment.pedido_id }).first()).liberado_cozinha_em, null);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    });
    test('concurrent commands produce one financial order, credential and dispatch reservation', async () => {
        let calls = 0;
        const transport = async () => { calls++; return new Response('{"unknown":true}', { status: 200 }); };
        const results = await Promise.all(Array.from({ length: 5 }, () => module.executeH1SingleLink(options({ transport }))));
        assert.equal(calls, 1);
        assert.equal(results.filter(result => !result.already_reserved).length, 1);
        assert.equal(Number((await db('pagamentos').count('* as n').first()).n), 1);
        assert.equal(Number((await db('pedidos').count('* as n').first()).n), 1);
        assert.equal(Number((await db('infinitepay_credenciais').count('* as n').first()).n), 1);
        for (const event_key of ['h1:links:command-reservation', 'h1:links:dispatch-budget']) {
            assert.equal(Number((await db('pagamentos_eventos').where({ event_key }).count('* as n').first()).n), 1);
        }
    });
    test('timeout stays INCERTA and blocks a new command even after a fresh database connection', async () => {
        let calls = 0;
        const transport = async () => { calls++; return new Promise(() => {}); };
        const result = await module.executeH1SingleLink(options({ transport, timeoutMs: 20 }));
        assert.equal(result.attempt_status, 'INCERTA'); assert.equal(result.response_received, false);
        const restarted = knex({ client: 'pg', connection: db.client.config.connection, searchPath: db.client.config.searchPath, pool: { min: 0, max: 2 } });
        try {
            const again = await module.executeH1SingleLink(options({ db: restarted, transport }));
            assert.equal(again.already_reserved, true); assert.equal(calls, 1);
        } finally { await restarted.destroy(); }
        assert.equal((await db('pagamentos').first()).bloqueia_nova_cobranca, true);
    });
    test('an abandoned committed command reservation cannot be reclaimed to dispatch', async () => {
        await db('pagamentos_eventos').insert({ event_key: 'h1:links:command-reservation', tipo_evento: 'H1_RESERVA_COMANDO_LINKS',
            payload_filtrado: {}, status_processamento: 'PENDENTE_IDENTIFICACAO' });
        let calls = 0;
        const result = await module.executeH1SingleLink(options({ transport: async () => { calls++; } }));
        assert.equal(result.already_reserved, true); assert.equal(calls, 0);
        assert.equal(Number((await db('pedidos').count('* as n').first()).n), 0);
    });
    test('conflicting PIX classification rolls back the entire command without rewriting methods or credentials', async () => {
        const [method] = await db('metodos_pagamento').insert({ nome: 'Preservar método existente', codigo: 'PIX', tipo_financeiro: 'CREDITO' }).returning('*');
        let calls = 0;
        await assert.rejects(module.executeH1SingleLink(options({ transport: async () => { calls++; } })));
        assert.equal(calls, 0); assert.deepEqual(await db('metodos_pagamento').where({ id: method.id }).first(), method);
        assert.equal(Number((await db('infinitepay_credenciais').count('* as n').first()).n), 0);
        assert.equal(Number((await db('pagamentos_eventos').count('* as n').first()).n), 0);
        assert.equal((await db('config_infinitepay').first()).credencial_atual_id, null);
    });
    test('invalid key, another account or missing explicit transport fail before any financial mutation', async () => {
        for (const extra of [{ apiKey: ' ' }, { apiKey: 'key\nunsafe' }, { handle: 'another-account' }, { transport: undefined }]) {
            await assert.rejects(module.executeH1SingleLink(options({ transport: async () => { throw new Error('must not call'); }, ...extra })));
        }
        assert.equal(Number((await db('pedidos').count('* as n').first()).n), 0);
        assert.equal(Number((await db('pagamentos_eventos').count('* as n').first()).n), 0);
    });
    test('non-JSON provider error is observable without printing its body or repeating the request', async () => {
        let calls = 0;
        const result = await module.executeH1SingleLink(options({ transport: async () => {
            calls++; return new Response('sensitive echo ' + apiKey, { status: 502 });
        } }));
        assert.equal(calls, 1); assert.equal(result.http_status, 502); assert.equal(result.json_structure, 'NON_JSON');
        assert.equal(JSON.stringify(result).includes(apiKey), false);
        const shownAgain = await module.readH1LinkResult(options());
        assert.equal(shownAgain.http_status, 502); assert.equal(calls, 1);
    });
});
