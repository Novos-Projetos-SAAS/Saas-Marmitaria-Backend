import { describe, test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { executeH1SingleLink } from '../../src/homologation/infinitepayH1SingleLink.js';
import { executeH2Check, readH2CheckResult } from '../../src/homologation/infinitepayH2Check.js';
import { encryptH1Observation, decryptH1Observation } from '../../src/homologation/infinitepayH1.js';
import { createPaymentOutboxService } from '../../src/services/paymentOutboxService.js';

const apiKey = 'SYNTHETIC_H3_KEY_NEVER_EXPOSE', origin = 'https://synthetic-h3.trycloudflare.com';
const independent = { success: true, paid: true, amount: 100, paid_amount: 100, installments: 1, capture_method: 'pix' };

describe('H3 manual reconciliation and isolated durable consumer', { concurrency: false }, () => {
    let h3, fixture, db, captureKey, previous, payment, paid, originalEvidence, captureTimes;
    before(async () => { h3 = await import('../../src/homologation/infinitepayH3.js'); });
    beforeEach(async () => {
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest(); captureKey = randomBytes(32);
        previous = { keys: process.env.INFINITEPAY_ENCRYPTION_KEYS, version: process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION };
        process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: captureKey.toString('base64') }); process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
        await executeH1SingleLink({ db, captureKey, publicOrigin: origin, handle: 'matheuszxp', apiKey,
            transport: async () => new Response(JSON.stringify({ url: 'https://checkout.infinitepay.io/SYNTHETIC_PRIVATE' })) });
        payment = await db('pagamentos').first();
        const marker = await db('pagamentos_eventos').where({ event_key: 'h1:links:command-reservation' }).first();
        const original = JSON.parse(decryptH1Observation(marker.payload_filtrado, captureKey).body);
        const common = { order_nsu: payment.order_nsu, invoice_slug: 'SYNTHETIC_PRIVATE_INVOICE', amount: 100 };
        paid = { ...common, ...independent, event_type: 'paid', transaction_nsu: 'SYNTHETIC_PRIVATE_TRANSACTION',
            receipt_url: 'https://recibo.infinitepay.io/matheuszxp/SYNTHETIC_PRIVATE_TRANSACTION' };
        const bodies = [{ ...common, event_type: 'created' }, { ...common, event_type: 'settled' }, paid,
            { r: new URL(original.redirect_url).searchParams.get('r'), order_nsu: payment.order_nsu,
                transaction_nsu: paid.transaction_nsu, transaction_id: paid.transaction_nsu, slug: common.invoice_slug,
                capture_method: 'pix', receipt_url: paid.receipt_url }];
        for (let i = 0; i < 4; i++) await db('pagamentos_eventos').insert({ id: 26 + i, event_key: 'h3:fixture:' + i,
            tipo_evento: i < 3 ? 'H1_OBSERVACAO_WEBHOOK' : 'H1_OBSERVACAO_RETURN', status_processamento: 'PENDENTE_IDENTIFICACAO',
            payload_filtrado: encryptH1Observation({ body: JSON.stringify(bodies[i]), headers: {} }, captureKey) });
        await executeH2Check({ db, captureKey, apiKey, transport: async () => new Response(JSON.stringify(independent)) });
        originalEvidence = await db('pagamentos_eventos').orderBy('id');
        captureTimes = ['h2:payment-check:response', 'h2:payment-check:dispatch-reservation'].map(key =>
            new Date(originalEvidence.find(row => row.event_key === key).recebido_em).getTime());
        assert.ok(captureTimes[0] >= captureTimes[1] && captureTimes[0] - captureTimes[1] <= 30000,
            'The synthetic independent response must follow its reservation within the capture deadline.');
    });
    afterEach(async () => {
        if (fixture) await fixture.close();
        if (previous) for (const [field, name] of [['keys', 'INFINITEPAY_ENCRYPTION_KEYS'], ['version', 'INFINITEPAY_ENCRYPTION_KEY_VERSION']]) {
            if (previous[field] === undefined) delete process.env[name]; else process.env[name] = previous[field];
        }
    });
    const options = extra => ({ db, captureKey, apiKey, now: () => new Date(captureTimes[0] + 1000), receiptTransport: async (url, init) => {
        assert.equal(url, paid.receipt_url); assert.equal(init.method, 'HEAD'); assert.equal(init.redirect, 'error');
        assert.equal(init.headers, undefined); return new Response(null, { status: 200 });
    }, ...extra });
    async function run(extra = {}) {
        const preview = await h3.previewH3(options(extra));
        return h3.reconcileH3(options({ ...extra, expectedFingerprint: preview.fingerprint }));
    }
    async function blocked() {
        assert.equal((await db('pagamentos').where({ id: payment.id }).first()).status, 'INCERTA');
        assert.equal((await db('pedidos').where({ id: payment.pedido_id }).first()).liberado_cozinha_em, null);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
        assert.equal(await db('pagamentos_eventos').where({ event_key: 'h3:reconciliation:done' }).first(), undefined);
    }
    test('preview validates recorded proof and receipt without modifying any evidence or financial state', async () => {
        const preview = await h3.previewH3(options());
        assert.equal(preview.summary.ready, true); assert.equal(preview.summary.evidence_max_age_hours, 24);
        assert.equal(preview.summary.receipt_https_checked, true); assert.equal(preview.summary.amount_centavos, 100);
        assert.doesNotMatch(JSON.stringify(preview.summary), /SYNTHETIC_PRIVATE|SYNTHETIC_H3_KEY|H1-MARMITARIA/);
        assert.deepEqual(await db('pagamentos_eventos').orderBy('id'), originalEvidence); await blocked();
    });
    test('confirmation requires the exact phrase and an interactive terminal', async () => {
        for (const [answer, expected] of [['CONFIRMAR H3 100 CENTAVOS', true], ['sim', false], ['', false]]) {
            const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true;
            const waiting = h3.confirmH3({ input, output }); setImmediate(() => input.end(answer + '\n'));
            assert.equal(await waiting, expected);
        }
        await assert.rejects(h3.confirmH3({ input: new PassThrough(), output: new PassThrough() })); await blocked();
    });
    test('the existing financial processor commits PAGA, receipt and one release outbox atomically', async () => {
        const result = await run(); assert.equal(result.payment_status, 'PAGA'); assert.equal(result.kitchen_logically_released, true);
        assert.equal(result.outbox_count, 1); assert.equal(result.consumer_effects, 0);
        const saved = await db('pagamentos').where({ id: payment.id }).first();
        assert.equal(saved.transaction_nsu, paid.transaction_nsu); assert.equal(saved.invoice_slug, paid.invoice_slug);
        assert.equal(saved.receipt_url, paid.receipt_url); assert.equal(saved.capture_method, 'pix'); assert.equal(saved.installments, 1);
        assert.equal(String(saved.valor_base_provider_centavos), '100'); assert.equal(String(saved.valor_pago_provider_centavos), '100');
        assert.ok(saved.provider_verified_at); assert.ok(saved.pago_em); assert.equal(saved.liquidado_em, null);
        for (const row of originalEvidence) assert.deepEqual(await db('pagamentos_eventos').where({ id: row.id }).first(), row);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
        assert.equal((await readH2CheckResult({ db, captureKey })).payment_confirmed, true);
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_H3_KEY|H1-MARMITARIA/);
    });
    test('concurrent and restarted reconciliation produces exactly one committed effect', async () => {
        const preview = await h3.previewH3(options());
        await Promise.all(Array.from({ length: 5 }, () => h3.reconcileH3(options({ expectedFingerprint: preview.fingerprint }))));
        const first = await db('pagamentos').where({ id: payment.id }).first();
        const again = await h3.reconcileH3(options({ receiptTransport: async () => { throw new Error('RECHECK_NOT_NEEDED'); } }));
        assert.equal(again.already_reconciled, true); assert.equal(again.outbox_count, 1);
        assert.deepEqual(await db('pagamentos').where({ id: payment.id }).first(), first);
        assert.equal(Number((await db('pagamentos_eventos').where({ event_key: 'h3:reconciliation:done' }).count('* as n').first()).n), 1);
    });
    for (const target of ['snapshot item', 'webhook observation']) test(target + ' writes wait until the financial transaction commits', async () => {
        const gateKey = 731943;
        const gate = await db.client.acquireConnection();
        let reconciling, writing, outcomes, changed = false;
        await db.raw('SELECT pg_advisory_lock(?)', [gateKey]).connection(gate);
        try {
            await db.raw(`CREATE FUNCTION hold_h3_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF NEW.status='PAGA' THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END $$`);
            await db.raw('CREATE TRIGGER hold_h3_commit BEFORE UPDATE ON pagamentos FOR EACH ROW EXECUTE FUNCTION hold_h3_commit()');
            reconciling = run();
            const deadline = Date.now() + 4000;
            let waiting = false;
            while (Date.now() < deadline) {
                const result = await db.raw('SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND objid=? AND NOT granted) AS waiting', [gateKey]);
                if (result.rows[0].waiting) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            writing = (target === 'snapshot item'
                ? db('itens_pedido').where({ pedido_id: payment.pedido_id }).update({ observacao: 'SYNTHETIC_CONCURRENT_CHANGE' })
                : db('pagamentos_eventos').insert({ event_key: 'h3:synthetic-concurrent-observation', tipo_evento: 'H1_OBSERVACAO_WEBHOOK',
                    status_processamento: 'PENDENTE_IDENTIFICACAO', payload_filtrado: encryptH1Observation({
                        body: JSON.stringify({ order_nsu: payment.order_nsu, event_type: 'refunded' }), headers: {} }, captureKey) }))
                .then(() => { changed = true; });
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(changed, false);
        } finally {
            await db.raw('SELECT pg_advisory_unlock(?)', [gateKey]).connection(gate);
            await db.client.releaseConnection(gate);
            outcomes = await Promise.allSettled([reconciling, writing].filter(Boolean));
        }
        assert.equal(outcomes.every(result => result.status === 'fulfilled'), true);
        assert.equal(changed, true);
        assert.equal((await db('pagamentos').where({ id: payment.id }).first()).status, 'PAGA');
        assert.ok(await db('pagamentos_eventos').where({ event_key: 'h3:reconciliation:done' }).first());
    });
    for (const [name, offset] of [['expired', 25 * 3600000], ['future', -3600000]]) {
        test('a ' + name + ' independent proof blocks without API calls or writes', async () => {
            await assert.rejects(h3.previewH3(options({ now: () => new Date(captureTimes[0] + offset) })), error => error.code === 'H3_EVIDENCE_EXPIRED_OR_FUTURE');
            await blocked();
        });
    }
    for (const variant of ['order', 'slug alias', 'blank order']) test('a later provider observation with ' + variant + ' blocks offline approval until reviewed', async () => {
        const capture = await db('pagamentos_eventos').where({ event_key: 'h2:payment-check:response' }).first();
        const body = variant === 'order' ? { order_nsu: payment.order_nsu, event_type: 'refunded' }
            : variant === 'slug alias' ? { order_nsu: 'OTHER_SYNTHETIC_ORDER', slug: paid.invoice_slug, event_type: 'refunded' }
                : { order_nsu: '   ', event_type: 'refunded' };
        await db('pagamentos_eventos').insert({ event_key: 'h3:synthetic-later-signal', tipo_evento: 'H1_OBSERVACAO_WEBHOOK',
            recebido_em: new Date(new Date(capture.recebido_em).getTime() + 1000), status_processamento: 'PENDENTE_IDENTIFICACAO',
            payload_filtrado: encryptH1Observation({ body: JSON.stringify(body), headers: {} }, captureKey) });
        await assert.rejects(run(), error => error.code === 'H3_NEW_PROVIDER_EVIDENCE_REQUIRES_REVIEW'); await blocked();
    });
    test('a changed financial snapshot cannot authorize reconciliation', async () => {
        await db('pedidos').where({ id: payment.pedido_id }).update({ nome_cliente: 'CHANGED_SYNTHETIC_SNAPSHOT' });
        await assert.rejects(run()); await blocked();
    });
    test('a credential different from the protected original key cannot authorize reconciliation', async () => {
        await assert.rejects(run({ apiKey: 'SYNTHETIC_CHANGED_KEY' }), error => error.code === 'H3_CREDENTIAL_MISMATCH');
        await blocked();
    });
    test('an external transaction identifier already assigned to another attempt rolls back H3', async () => {
        const order = await db('pedidos').where({ id: payment.pedido_id }).first();
        const [other] = await db('pedidos').insert({ nome_cliente: 'OTHER SYNTHETIC', telefone_cliente: '00000000000',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: order.metodo_pagamento_id, valor_total: '1.00', fluxo_pagamento: 'INFINITEPAY' }).returning('id');
        await db('pagamentos').insert({ pedido_id: other.id, tentativa_numero: 1, order_nsu: 'OTHER_SYNTHETIC_ORDER', status: 'FALHOU',
            bloqueia_nova_cobranca: false, credencial_id: payment.credencial_id, handle_snapshot: payment.handle_snapshot,
            valor_centavos: 100, valid_until: payment.valid_until, transaction_nsu: paid.transaction_nsu });
        await assert.rejects(run(), error => error.code === 'H3_FINANCIAL_TRANSACTION_REJECTED'); await blocked();
    });
    test('receipt redirects are rejected before any financial update', async () => {
        await assert.rejects(run({ receiptTransport: async () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/' } }) }));
        await blocked();
    });
    test('a receipt path not bound to the confirmed transaction is blocked', async () => {
        for (const id of [28, 29]) {
            const row = await db('pagamentos_eventos').where({ id }).first(), observed = decryptH1Observation(row.payload_filtrado, captureKey);
            const body = { ...JSON.parse(observed.body), receipt_url: 'https://recibo.infinitepay.io/OTHER_TRANSACTION' };
            await db('pagamentos_eventos').where({ id }).update({ payload_filtrado: encryptH1Observation({ ...observed, body: JSON.stringify(body) }, captureKey) });
        }
        await assert.rejects(run()); await blocked();
    });
    for (const point of ['outbox', 'marker']) {
        test('failure at ' + point + ' rolls back the complete financial transaction and new normalized event', async () => {
            const table = point === 'outbox' ? 'outbox_eventos' : 'pagamentos_eventos';
            await db.raw(`CREATE FUNCTION deny_h3() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF TG_TABLE_NAME='outbox_eventos' OR NEW.event_key='h3:reconciliation:done' THEN RAISE EXCEPTION 'SYNTHETIC_FAILURE'; END IF; RETURN NEW; END $$`);
            await db.raw('CREATE TRIGGER deny_h3 BEFORE INSERT ON ?? FOR EACH ROW EXECUTE FUNCTION deny_h3()', [table]);
            await assert.rejects(run()); await blocked();
            assert.deepEqual(await db('pagamentos_eventos').orderBy('id'), originalEvidence);
        });
    }
    test('the isolated consumer persists one effect across duplicate calls, new instances and concurrency', async () => {
        await run(); const row = await db('outbox_eventos').first();
        const consumer = h3.createH3Consumer({ db, pedidoId: payment.pedido_id, pagamentoId: payment.id });
        const dto = { id: row.id, pedidoId: row.pedido_id, tipo: row.tipo, key: row.chave_unica };
        await Promise.all(Array.from({ length: 5 }, () => consumer(dto)));
        await h3.createH3Consumer({ db, pedidoId: payment.pedido_id, pagamentoId: payment.id })(dto);
        assert.equal((await h3.readH3Status({ db, captureKey })).consumer_effects, 1);
        await h3.deliverH3({ db, captureKey });
        const status = await h3.readH3Status({ db, captureKey }); assert.equal(status.consumer_effects, 1); assert.equal(status.outbox_status, 'CONCLUIDO');
    });
    test('failure after delivery and before ack replays the key but not the durable logical effect', async () => {
        await run(); const row = await db('outbox_eventos').first(); let clock = new Date();
        const receiver = h3.createH3Consumer({ db, pedidoId: payment.pedido_id, pagamentoId: payment.id });
        await db.raw(`CREATE FUNCTION deny_h3_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.status='CONCLUIDO' THEN RAISE EXCEPTION 'SYNTHETIC_ACK_FAILURE'; END IF; RETURN NEW; END $$`);
        await db.raw('CREATE TRIGGER deny_h3_ack BEFORE UPDATE ON outbox_eventos FOR EACH ROW EXECUTE FUNCTION deny_h3_ack()');
        const worker = () => createPaymentOutboxService({ db, deliver: receiver, now: () => new Date(clock), leaseMs: 50 });
        await assert.rejects(worker().processEvent(row.id));
        assert.equal((await h3.readH3Status({ db, captureKey })).consumer_effects, 1);
        await db.raw('ALTER TABLE outbox_eventos DISABLE TRIGGER deny_h3_ack'); clock = new Date(clock.getTime() + 100);
        await worker().processEvent(row.id);
        const status = await h3.readH3Status({ db, captureKey }); assert.equal(status.consumer_effects, 1); assert.equal(status.outbox_status, 'CONCLUIDO');
    });
    test('consumer rejects an unrelated event and never signals physical kitchen delivery', async () => {
        await run(); const consumer = h3.createH3Consumer({ db, pedidoId: payment.pedido_id, pagamentoId: payment.id });
        await assert.rejects(consumer({ id: 99999, pedidoId: payment.pedido_id, tipo: 'PEDIDO_LIBERADO', key: 'OTHER' }));
        await h3.deliverH3({ db, captureKey }); const status = await h3.readH3Status({ db, captureKey });
        assert.equal(status.consumer_effects, 1); assert.equal(status.physical_delivery, false);
    });
});
