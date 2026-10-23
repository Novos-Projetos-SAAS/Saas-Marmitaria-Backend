import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, historicalOrder } from '../helpers/testDatabase.js';

// Real PostgreSQL writes: removing an invariant must allow a rejected write and fail its test.
let fixture;
let db;
let sequence = 0;
let credential;
let otherCredential;
before(async () => {
    fixture = await createTestDatabase();
    db = fixture.db;
    await db.migrate.latest();
    await historicalOrder(db, { id: 701, methodId: 91 });
    await historicalOrder(db, { id: 702, methodId: 17 });
    [credential, otherCredential] = await db('infinitepay_credenciais').insert([
        credentialData('synthetic-account-a'), credentialData('synthetic-account-b'),
    ]).returning('*');
});
after(async () => { if (fixture) await fixture.close(); });

function credentialData(handle) {
    return { handle, api_key_ciphertext: 'SYNTHETIC-NOT-A-KEY', api_key_iv: '0'.repeat(24),
        api_key_tag: '1'.repeat(24), key_version: 1 };
}
function paymentData(overrides = {}) {
    return { pedido_id: 701, tentativa_numero: ++sequence, order_nsu: `SYNTH-INTEGRITY-${sequence}`,
        status: 'CANCELADA', bloqueia_nova_cobranca: false, valor_centavos: 2000,
        valid_until: '2030-01-01T12:00:00Z', ...overrides };
}
async function payment(overrides = {}) {
    return (await db('pagamentos').insert(paymentData(overrides)).returning('*'))[0];
}
async function rejectsUnchanged(tables, action, code, constraint) {
    const names = Array.isArray(tables) ? tables : [tables];
    const beforeRows = await Promise.all(names.map(name => db(name).select('*').orderBy('id')));
    await assert.rejects(action, error => {
        assert.equal(error.code, code, 'SQLSTATE');
        if (constraint) assert.equal(error.constraint, constraint, 'constraint');
        return true;
    });
    for (let i = 0; i < names.length; i++) {
        assert.deepEqual(await db(names[i]).select('*').orderBy('id'), beforeRows[i], `${names[i]} unchanged`);
    }
}

test('payment order_nsu cannot be reused by a different order', async () => {
    const existing = await payment();
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({
        pedido_id: 702, order_nsu: existing.order_nsu,
    })), '23505', 'pagamentos_order_nsu_unique');
});
test('payment attempt number cannot be reused within one order with a different NSU', async () => {
    const existing = await payment();
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({
        tentativa_numero: existing.tentativa_numero,
    })), '23505', 'pagamentos_pedido_id_tentativa_numero_unique');
    // The same attempt number is valid for another order; this is not global uniqueness.
    await payment({ pedido_id: 702, tentativa_numero: existing.tentativa_numero });
});
for (const [label, patch, constraint] of [
    ['unknown payment status', { status: 'DESCONHECIDO' }, 'ip_payment_status'],
    ['different provider', { provedor: 'OTHER' }, 'ip_payment_provider'],
    ['zero payment attempt', { tentativa_numero: 0 }, 'ip_payment_attempt'],
    ['negative payment attempt', { tentativa_numero: -1 }, 'ip_payment_attempt'],
    ['zero charged value', { valor_centavos: 0 }, 'ip_payment_value'],
    ['negative charged value', { valor_centavos: -1 }, 'ip_payment_value'],
]) {
    test(`payment rejects ${label} without inserting a row`, async () => {
        await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData(patch)), '23514', constraint);
    });
}
for (const [label, patch] of [
    ['credential without handle', () => ({ credencial_id: credential.id })],
    ['handle without credential', () => ({ handle_snapshot: credential.handle })],
]) {
    test(`payment rejects ${label}`, async () => {
        await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData(patch())),
            '23514', 'ip_payment_credential_pair');
    });
}
test('payment rejects a real credential paired with another real account handle', async () => {
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({
        credencial_id: credential.id, handle_snapshot: otherCredential.handle,
    })), '23503', 'pagamentos_credencial_id_handle_snapshot_foreign');
});
test('payment rejects a nonexistent credential even with both pair fields filled', async () => {
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({
        credencial_id: 999999, handle_snapshot: credential.handle,
    })), '23503', 'pagamentos_credencial_id_handle_snapshot_foreign');
});
test('a payment-referenced credential cannot be deleted', async () => {
    await payment({ credencial_id: credential.id, handle_snapshot: credential.handle });
    await rejectsUnchanged(['infinitepay_credenciais', 'pagamentos'],
        () => db('infinitepay_credenciais').where({ id: credential.id }).del(),
        '23001', 'pagamentos_credencial_id_handle_snapshot_foreign');
});
test('a current config credential cannot be deleted', async () => {
    await db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: otherCredential.id });
    await rejectsUnchanged(['infinitepay_credenciais', 'config_infinitepay'],
        () => db('infinitepay_credenciais').where({ id: otherCredential.id }).del(),
        '23001', 'config_infinitepay_credencial_atual_id_foreign');
});
test('config cannot point to a nonexistent current credential', async () => {
    await rejectsUnchanged('config_infinitepay',
        () => db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: 999999 }),
        '23503', 'config_infinitepay_credencial_atual_id_foreign');
});
test('credential cannot reference a nonexistent config', async () => {
    await rejectsUnchanged('infinitepay_credenciais', () => db('infinitepay_credenciais').insert({
        ...credentialData('synthetic-missing-config'), config_id: 999999,
    }), '23503', 'infinitepay_credenciais_config_id_foreign');
});
for (const key_version of [0, -1]) {
    test(`credential rejects key version ${key_version}`, async () => {
        await rejectsUnchanged('infinitepay_credenciais', () => db('infinitepay_credenciais').insert({
            ...credentialData(`synthetic-version-${key_version}`), key_version,
        }), '23514', 'ip_credential_keyversion');
    });
}
test('payment rejects a nonexistent order', async () => {
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({ pedido_id: 999999 })),
        '23503', 'pagamentos_pedido_id_foreign');
});
test('an order referenced by payment cannot be deleted or lose cascading items', async () => {
    await payment();
    await rejectsUnchanged(['pedidos', 'itens_pedido', 'pagamentos'],
        () => db('pedidos').where({ id: 701 }).del(), '23001', 'pagamentos_pedido_id_foreign');
});

for (const [table, field, constraint] of [
    ['pagamentos', 'return_nonce_hash', 'ip_payment_nonce_hash'],
    ['pedido_acessos', 'token_hash', 'ip_access_hash'],
]) {
    for (const [label, value] of [['short', 'a'.repeat(63)], ['uppercase', 'A'.repeat(64)], ['nonhex', 'g'.repeat(64)]]) {
        test(`${table} rejects ${label} ${field}`, async () => {
            const data = table === 'pagamentos' ? paymentData({ [field]: value }) : {
                pedido_id: 702, token_hash: value, escopo: 'STATUS', criado_em: '2026-01-01', expira_em: '2030-01-01',
            };
            await rejectsUnchanged(table, () => db(table).insert(data), '23514', constraint);
        });
    }
}
test('payment return nonce hashes cannot be reused by another order', async () => {
    await payment({ return_nonce_hash: 'a'.repeat(64) });
    await rejectsUnchanged('pagamentos', () => db('pagamentos').insert(paymentData({
        pedido_id: 702, return_nonce_hash: 'a'.repeat(64),
    })), '23505', 'pagamentos_return_nonce_hash_unique');
});
test('access token hashes cannot be reused across orders or scopes', async () => {
    await db('pedido_acessos').insert({ pedido_id: 702, token_hash: 'b'.repeat(64), escopo: 'STATUS',
        criado_em: '2026-01-01', expira_em: '2030-01-01' });
    await rejectsUnchanged('pedido_acessos', () => db('pedido_acessos').insert({
        pedido_id: 701, token_hash: 'b'.repeat(64), escopo: 'TITULAR', criado_em: '2026-01-01', expira_em: '2030-01-01',
    }), '23505', 'pedido_acessos_token_hash_unique');
});
for (const [label, expira_em] of [['equal to creation', '2026-01-01'], ['before creation', '2025-12-31']]) {
    test(`access expiry cannot be ${label}`, async () => {
        await rejectsUnchanged('pedido_acessos', () => db('pedido_acessos').insert({
            pedido_id: 702, token_hash: 'c'.repeat(64), escopo: 'TITULAR', criado_em: '2026-01-01', expira_em,
        }), '23514', 'ip_access_expiry');
    });
}
test('access token cannot reference a nonexistent order', async () => {
    await rejectsUnchanged('pedido_acessos', () => db('pedido_acessos').insert({
        pedido_id: 999999, token_hash: 'd'.repeat(64), escopo: 'STATUS', criado_em: '2026-01-01', expira_em: '2030-01-01',
    }), '23503', 'pedido_acessos_pedido_id_foreign');
});
test('an access-referenced order cannot be deleted', async () => {
    await historicalOrder(db, { id: 704, methodId: 309 });
    await db('pedido_acessos').insert({ pedido_id: 704, token_hash: 'e'.repeat(64), escopo: 'STATUS',
        criado_em: '2026-01-01', expira_em: '2030-01-01' });
    await rejectsUnchanged(['pedidos', 'itens_pedido', 'pedido_acessos'],
        () => db('pedidos').where({ id: 704 }).del(), '23001', 'pedido_acessos_pedido_id_foreign');
});

for (const [label, patch, code, constraint] of [
    ['nonexistent payment', { pagamento_id: 999999 }, '23503', 'pagamentos_eventos_pagamento_id_foreign'],
    ['unknown processing state', { status_processamento: 'UNKNOWN' }, '23514', 'ip_event_state'],
    ['negative retry count', { tentativas: -1 }, '23514', 'ip_event_attempts'],
]) {
    test(`payment event rejects ${label}`, async () => {
        await rejectsUnchanged('pagamentos_eventos', () => db('pagamentos_eventos').insert({
            event_key: `synthetic-event-${++sequence}`, tipo_evento: 'SINTETICO', ...patch,
        }), code, constraint);
    });
}
test('payment event key deduplicates even when payment association differs', async () => {
    const p = await payment();
    const [event] = await db('pagamentos_eventos').insert({ event_key: 'synthetic-dedupe', tipo_evento: 'SINTETICO' }).returning('*');
    await rejectsUnchanged('pagamentos_eventos', () => db('pagamentos_eventos').insert({
        event_key: event.event_key, pagamento_id: p.id, tipo_evento: 'OUTRO_SINTETICO',
    }), '23505', 'pagamentos_eventos_event_key_unique');
});
test('an event-referenced payment cannot be deleted', async () => {
    const p = await payment();
    await db('pagamentos_eventos').insert({ event_key: 'synthetic-linked-event', pagamento_id: p.id, tipo_evento: 'SINTETICO' });
    await rejectsUnchanged(['pagamentos', 'pagamentos_eventos'], () => db('pagamentos').where({ id: p.id }).del(),
        '23001', 'pagamentos_eventos_pagamento_id_foreign');
});
for (const [label, patch, code, constraint] of [
    ['nonexistent order', { pedido_id: 999999 }, '23503', 'outbox_eventos_pedido_id_foreign'],
    ['unknown state', { status: 'UNKNOWN' }, '23514', 'ip_outbox_status'],
    ['negative retry count', { tentativas: -1 }, '23514', 'ip_outbox_attempts'],
    ['unknown event type', { tipo: 'UNKNOWN' }, '23514', 'ip_outbox_type'],
]) {
    test(`outbox rejects ${label}`, async () => {
        await rejectsUnchanged('outbox_eventos', () => db('outbox_eventos').insert({
            pedido_id: 701, tipo: 'PAGAMENTO_ATUALIZADO', chave_unica: `synthetic-outbox-${++sequence}`, ...patch,
        }), code, constraint);
    });
}
test('outbox dedupe key is unique across orders', async () => {
    await db('outbox_eventos').insert({ pedido_id: 701, tipo: 'PAGAMENTO_ATUALIZADO', chave_unica: 'synthetic-outbox-dedupe' });
    await rejectsUnchanged('outbox_eventos', () => db('outbox_eventos').insert({
        pedido_id: 702, tipo: 'PAGAMENTO_ATUALIZADO', chave_unica: 'synthetic-outbox-dedupe',
    }), '23505', 'outbox_eventos_chave_unica_unique');
});
test('a completed outbox kitchen release prevents a second release with another key', async () => {
    await db('outbox_eventos').insert({ pedido_id: 701, tipo: 'PEDIDO_LIBERADO', chave_unica: 'synthetic-release-first',
        status: 'CONCLUIDO', processado_em: '2026-01-01' });
    await rejectsUnchanged('outbox_eventos', () => db('outbox_eventos').insert({
        pedido_id: 701, tipo: 'PEDIDO_LIBERADO', chave_unica: 'synthetic-release-second',
    }), '23505', 'ip_outbox_release_once');
});
test('changing an update outbox event into a second release is rejected', async () => {
    await historicalOrder(db, { id: 705, methodId: 310 });
    await db('outbox_eventos').insert({ pedido_id: 705, tipo: 'PEDIDO_LIBERADO', chave_unica: 'synthetic-existing-release' });
    const [event] = await db('outbox_eventos').insert({ pedido_id: 705, tipo: 'PAGAMENTO_ATUALIZADO',
        chave_unica: 'synthetic-release-update' }).returning('*');
    await rejectsUnchanged('outbox_eventos', () => db('outbox_eventos').where({ id: event.id }).update({ tipo: 'PEDIDO_LIBERADO' }),
        '23505', 'ip_outbox_release_once');
});
test('an outbox-referenced order cannot be deleted', async () => {
    // A separate order has no payments or access records to mask this FK.
    await historicalOrder(db, { id: 703, methodId: 308 });
    await db('outbox_eventos').insert({ pedido_id: 703, tipo: 'PAGAMENTO_ATUALIZADO', chave_unica: 'synthetic-outbox-order-delete' });
    await rejectsUnchanged(['pedidos', 'itens_pedido', 'outbox_eventos'], () => db('pedidos').where({ id: 703 }).del(),
        '23001', 'outbox_eventos_pedido_id_foreign');
});

const requestId = '11111111-1111-4111-8111-111111111111';
for (const [label, patch, code, constraint] of [
    ['UUID without hash', { client_request_id: requestId }, '23514', 'ip_pedido_request_hash'],
    ['hash without UUID', { client_payload_hash: 'a'.repeat(64) }, '23514', 'ip_pedido_request_hash'],
    ['short payload hash', { client_request_id: requestId, client_payload_hash: 'a'.repeat(63) }, '23514', 'ip_pedido_request_hash'],
    ['uppercase payload hash', { client_request_id: requestId, client_payload_hash: 'A'.repeat(64) }, '23514', 'ip_pedido_request_hash'],
    ['nonhex payload hash', { client_request_id: requestId, client_payload_hash: 'g'.repeat(64) }, '23514', 'ip_pedido_request_hash'],
    ['malformed UUID', { client_request_id: 'not-a-uuid', client_payload_hash: 'a'.repeat(64) }, '22P02', undefined],
    ['unknown payment flow', { fluxo_pagamento: 'OTHER' }, '23514', 'ip_pedido_fluxo'],
]) {
    test(`order rejects ${label} and preserves every existing field`, async () => {
        await rejectsUnchanged('pedidos', () => db('pedidos').where({ id: 701 }).update(patch), code, constraint);
    });
}
test('request UUID deduplicates different orders even with different payload hashes', async () => {
    await db('pedidos').where({ id: 701 }).update({ client_request_id: requestId, client_payload_hash: 'a'.repeat(64) });
    await rejectsUnchanged('pedidos', () => db('pedidos').where({ id: 702 }).update({
        client_request_id: requestId, client_payload_hash: 'b'.repeat(64),
    }), '23505', 'ip_pedido_request_unique');
});
test('method financial type rejects an unknown classification', async () => {
    await rejectsUnchanged('metodos_pagamento', () => db('metodos_pagamento').where({ id: 91 }).update({ tipo_financeiro: 'OTHER' }),
        '23514', 'ip_metodo_tipo');
});
test('method code deduplicates different historical method IDs', async () => {
    await db('metodos_pagamento').where({ id: 91 }).update({ codigo: 'SYNTHETIC-CODE' });
    await rejectsUnchanged('metodos_pagamento', () => db('metodos_pagamento').where({ id: 17 }).update({ codigo: 'SYNTHETIC-CODE' }),
        '23505', 'ip_metodo_codigo_unique');
});
