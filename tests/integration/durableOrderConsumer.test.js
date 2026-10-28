import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createTestDatabase } from '../helpers/testDatabase.js';

let fixture, db, method, create, instant;
before(async () => {
    fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
    [method] = await db('metodos_pagamento').insert({ nome: 'PIX consumidor sintético', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
    await db.schema.createTable('synthetic_receiver', t => { t.text('key').primary(); t.integer('pedidoId'); t.text('receiptId'); });
    ({ createDurableOrderConsumer: create } = await import('../../src/services/durableOrderConsumer.js'));
});
after(async () => { await fixture?.close(); });
function clock() { return new Date(instant || '2026-10-27T15:00:00Z'); }
function consumer(adapter, extra = {}) { return create({ db, adapter, now: clock, leaseMs: 1000, timeoutMs: 1000, ...extra }); }
async function release({ payment = {}, order = {} } = {}) {
    const [p] = await db('pedidos').insert({ nome_cliente: 'SINTETICO', telefone_cliente: '00000000000', tipo_pedido: 'Remoto', metodo_entrega: 'Retirada',
        metodo_pagamento_id: method.id, valor_total: '20.10', fluxo_pagamento: 'INFINITEPAY', liberado_cozinha_em: clock(), ...order }).returning('*');
    await db('pagamentos').insert({ pedido_id: p.id, tentativa_numero: 1, order_nsu: randomUUID(), status: 'PAGA', valor_centavos: 2010,
        valor_base_provider_centavos: 2010, provider_verified_at: clock(), pago_em: clock(), transaction_nsu: 'SYNTHETIC-TX-' + p.id,
        invoice_slug: 'SYNTHETIC-INVOICE-' + p.id, capture_method: 'pix', valid_until: clock(), ...payment });
    const [e] = await db('outbox_eventos').insert({ pedido_id: p.id, tipo: 'PEDIDO_LIBERADO', chave_unica: 'pedido_liberado:' + p.id }).returning('*');
    return { id: e.id, pedidoId: p.id, tipo: e.tipo, key: e.chave_unica };
}
function adapter(extra = {}) {
    const base = { id: 'synthetic-kitchen', supportsIdempotency: true,
        async send(dto) {
            await db('synthetic_receiver').insert({ key: dto.key, pedidoId: dto.pedidoId, receiptId: 'synthetic-receipt-' + dto.pedidoId }).onConflict('key').ignore();
            return base.lookupReceipt(dto);
        },
        async lookupReceipt(dto) {
            const found = await db('synthetic_receiver').where({ key: dto.key }).first();
            return found ? { acknowledged: true, key: found.key, pedidoId: found.pedidoId, destination: base.id, receiptId: found.receiptId } : null;
        },
        async verifyReceipt(receipt, dto) { return receipt.receiptId === 'synthetic-receipt-' + dto.pedidoId; }
    };
    return Object.assign(base, extra);
}
function error(code) { return e => e.code === code && !/SECRET|private@example/.test(JSON.stringify(e, Object.getOwnPropertyNames(e))); }
function gate() { let open; return { promise: new Promise(resolve => { open = resolve; }), open: () => open() }; }

test('consumer refuses missing destination, verification or receipt recovery contract', () => {
    for (const value of [undefined, {}, adapter({ verifyReceipt: undefined }), adapter({ lookupReceipt: undefined }), adapter({ supportsIdempotency: undefined })]) {
        assert.throws(() => consumer(value), /consumidor/i);
    }
});

test('confirmed order creates a durable receipt once, with minimal DTO and no financial operation', async () => {
    const dto = await release(); let seen;
    const target = adapter(), send = target.send;
    target.send = async (...args) => { seen = args[0]; return send(...args); };
    const c = consumer(target); await c.deliver({ ...dto, apiKey: 'SECRET', receipt_url: 'https://private.invalid' }); await c.deliver(dto);
    assert.deepEqual(Object.keys(seen).sort(), ['id', 'key', 'pedidoId', 'tipo']);
    assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
    const saved = await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first();
    assert.equal(saved.status, 'RECEBIDA'); assert.equal(saved.tentativas, 1); assert.equal(saved.locked_by, null);
    assert.equal(saved.receipt_id, 'synthetic-receipt-' + dto.pedidoId);
    assert.equal(Number((await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).count('* as n').first()).n), 1);
});

test('a refunded historical proof cannot authorize a different unproven paid attempt', async () => {
    const dto = await release({ payment: { status: 'ESTORNADA', bloqueia_nova_cobranca: false } });
    await db('pagamentos').insert({ pedido_id: dto.pedidoId, tentativa_numero: 2, order_nsu: randomUUID(), status: 'PAGA', valor_centavos: 2010,
        valor_base_provider_centavos: 2010, valid_until: clock(), transaction_nsu: 'SYNTHETIC-UNPROVEN-TX', invoice_slug: 'SYNTHETIC-UNPROVEN-INVOICE', capture_method: 'pix' });
    await assert.rejects(consumer(adapter()).deliver(dto), error('ORDER_INELIGIBLE'));
    assert.equal(await db('synthetic_receiver').where({ key: dto.key }).first(), undefined);
});

for (const status of ['AGUARDANDO', 'INCERTA', 'FALHOU', 'ESTORNADA']) test('never sends a new operational delivery for payment ' + status, async () => {
    const dto = await release({ payment: { status } });
    await assert.rejects(consumer(adapter()).deliver(dto), error('ORDER_INELIGIBLE'));
    assert.equal(await db('synthetic_receiver').where({ key: dto.key }).first(), undefined);
});

for (const [label, options] of [
    ['missing independent proof', { payment: { provider_verified_at: null } }],
    ['wrong financial amount', { payment: { valor_base_provider_centavos: 1 } }],
    ['deleted order', { order: { deletado_em: '2026-10-27T15:00:00Z' } }],
    ['unpaid canceled order', { order: { status: 'Cancelado' }, payment: { status: 'AGUARDANDO' } }],
    ['posterior order', { order: { fluxo_pagamento: 'POSTERIOR' } }]
]) test('refuses ' + label + ' without physical effects', async () => {
    const dto = await release(options);
    await assert.rejects(consumer(adapter()).deliver(dto), error('ORDER_INELIGIBLE'));
    assert.equal(await db('synthetic_receiver').where({ key: dto.key }).first(), undefined);
});

test('concurrent consumers do not send the same key while a lease is owned', async () => {
    const dto = await release(), entered = gate(), finish = gate(), target = adapter(), send = target.send;
    target.send = async (...args) => { entered.open(); await finish.promise; return send(...args); };
    const first = consumer(target).deliver(dto); await entered.promise;
    try { await assert.rejects(consumer(adapter()).deliver(dto), error('DELIVERY_BUSY')); }
    finally { finish.open(); await first; }
    assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
});

test('missing, mismatched or unverifiable receipts never acknowledge destination receipt', async () => {
    for (const mode of ['absent', 'wrong_key', 'wrong_order', 'wrong_destination', 'unverified']) {
        const dto = await release(), target = adapter();
        target.send = async () => mode === 'absent' ? undefined : ({ acknowledged: true, key: mode === 'wrong_key' ? 'other' : dto.key,
            pedidoId: mode === 'wrong_order' ? dto.pedidoId + 1 : dto.pedidoId, destination: mode === 'wrong_destination' ? 'other' : target.id,
            receiptId: 'synthetic-receipt-' + dto.pedidoId });
        if (mode === 'unverified') target.verifyReceipt = async () => false;
        await assert.rejects(consumer(target).deliver(dto), error('RECEIPT_INVALID'));
        const row = await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first();
        assert.equal(row.status, 'INCERTA'); assert.equal(row.recebido_em, null);
    }
});

test('lost send response stays uncertain and a restart recovers by looking up the persisted destination receipt', async () => {
    const dto = await release(), target = adapter(), send = target.send;
    target.send = async (...args) => { await send(...args); throw new Error('SECRET private@example.invalid'); };
    await assert.rejects(consumer(target).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await assert.rejects(consumer(adapter()).deliver(dto), error('RECOVERY_REQUIRED'));
    await consumer(adapter()).recover(dto.key);
    const rows = await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).orderBy('numero');
    assert.deepEqual(rows.map(x => x.status), ['INCERTA', 'RECEBIDA']);
    assert.deepEqual(rows.map(x => x.operacao), ['ENVIO', 'RECUPERACAO']);
    assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
});

test('uncertain delivery without a receipt is never resent to a destination lacking idempotency', async () => {
    const dto = await release(); let sends = 0;
    const target = adapter({ supportsIdempotency: false, send: async () => { sends++; throw new Error('SECRET'); } });
    await assert.rejects(consumer(target).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await assert.rejects(consumer(target).recover(dto.key), error('RECOVERY_REQUIRES_IDEMPOTENCY'));
    assert.equal(sends, 1);
});

test('malformed receipt lookup is not interpreted as a confirmed absence authorizing resend', async () => {
    const dto = await release(); let sends = 0;
    const target = adapter({ send: async () => { sends++; throw new Error(); }, lookupReceipt: async () => undefined });
    await assert.rejects(consumer(target).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await assert.rejects(consumer(target).recover(dto.key), error('RECEIPT_INVALID'));
    assert.equal(sends, 1);
});

test('explicit recovery can resend the same key only to an idempotent destination', async () => {
    const dto = await release();
    await assert.rejects(consumer(adapter({ send: async () => { throw new Error(); } })).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await consumer(adapter()).recover(dto.key);
    assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'RECEBIDA');
    assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
});

test('expired lease requires explicit recovery and fences a late acknowledgment from the prior process', async () => {
    const dto = await release(), entered = gate(), finish = gate(), target = adapter(), send = target.send;
    target.send = async (...args) => { const receipt = await send(...args); entered.open(); await finish.promise; return receipt; };
    const first = consumer(target, { timeoutMs: 1000 }).deliver(dto); await entered.promise;
    instant = '2026-10-27T15:00:02Z';
    try {
        await assert.rejects(consumer(adapter()).deliver(dto), error('RECOVERY_REQUIRED'));
        await consumer(adapter()).recover(dto.key);
    } finally { finish.open(); await assert.rejects(first, error('DELIVERY_LEASE_LOST')); instant = undefined; }
    const attempts = await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).orderBy('numero');
    assert.equal(attempts[0].ultimo_erro, 'LEASE_EXPIRED'); assert.equal(attempts[1].status, 'RECEBIDA');
});

test('a killed consumer process leaves a durable reservation recoverable without a second destination effect', { timeout: 15000 }, async () => {
    const dto = await release();
    const source = `import knex from 'knex';
        import {testConnection} from './tests/helpers/testDatabase.js';
        import {createDurableOrderConsumer} from './src/services/durableOrderConsumer.js';
        const db=knex({client:'pg',connection:testConnection(),searchPath:[process.env.TEST_DATABASE_SCHEMA]});
        const adapter={id:'synthetic-kitchen',supportsIdempotency:true,
            async send(value){await db('synthetic_receiver').insert({key:value.key,pedidoId:value.pedidoId,receiptId:'synthetic-receipt-'+value.pedidoId});
                process.send('destination-received');return new Promise(()=>{});},
            async lookupReceipt(){return null;},async verifyReceipt(){return true;}};
        await createDurableOrderConsumer({db,adapter,now:()=>new Date('2026-10-27T15:00:00Z'),leaseMs:1000}).deliver(JSON.parse(process.env.SYNTHETIC_DELIVERY));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
            TEST_DATABASE_SCHEMA: fixture.schema, SYNTHETIC_DELIVERY: JSON.stringify(dto) } });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
        await new Promise((resolve, reject) => {
            child.once('message', value => value === 'destination-received' ? resolve() : reject(new Error('Unexpected synthetic process message.')));
            child.once('error', reject); child.once('exit', () => reject(new Error('Synthetic consumer exited before receipt.')));
        });
        child.kill('SIGTERM'); await exited;
        assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'ENVIANDO');
        instant = '2026-10-27T15:00:02Z'; await consumer(adapter()).recover(dto.key);
        assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'RECEBIDA');
        assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
    } finally { instant = undefined; if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } }
});

test('timeout does not wait forever or authorize automatic resend, even if the destination ignores abort', async () => {
    const dto = await release(), target = adapter({ send: () => new Promise(() => {}) });
    await assert.rejects(consumer(target, { timeoutMs: 20 }).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await assert.rejects(consumer(target).deliver(dto), error('RECOVERY_REQUIRED'));
    assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'INCERTA');
});

test('eligibility revalidation cannot allow an expired owner to start a destination send', async () => {
    const dto = await release(); let leased = false, sends = 0;
    const reserveObserved = (_response, query) => {
        if (query.sql.startsWith('update "infinitepay_entregas_operacionais"') && query.bindings.includes('ENVIANDO')) leased = true;
    };
    const delayedEligibility = query => {
        if (leased && query.sql.startsWith('select') && query.sql.includes('"pedidos"') && query.sql.includes('"financeiro"')) instant = '2026-10-27T15:00:02Z';
    };
    db.on('query-response', reserveObserved); db.on('query', delayedEligibility);
    try {
        await assert.rejects(consumer(adapter({ send: async () => { sends++; throw new Error(); } })).deliver(dto), error('DELIVERY_LEASE_LOST'));
        assert.equal(sends, 0);
    } finally { db.removeListener('query-response', reserveObserved); db.removeListener('query', delayedEligibility); instant = undefined; }
});

test('destination and outbox identities cannot be replaced after reserving a delivery', async () => {
    const dto = await release();
    await consumer(adapter()).deliver(dto);
    await assert.rejects(consumer(adapter({ id: 'other-destination' })).deliver(dto), error('DELIVERY_IDENTITY_CONFLICT'));
    await assert.rejects(consumer(adapter()).deliver({ ...dto, pedidoId: dto.pedidoId + 1 }), error('DELIVERY_IDENTITY_CONFLICT'));
});

test('persistent attempts reach their limit without deleting evidence or sending again', async () => {
    const dto = await release(), target = adapter({ send: async () => { throw new Error(); } });
    await assert.rejects(consumer(target, { maxAttempts: 1 }).deliver(dto), error('DESTINATION_UNCERTAIN'));
    await assert.rejects(consumer(target, { maxAttempts: 1 }).recover(dto.key), error('DELIVERY_ATTEMPTS_EXHAUSTED'));
    assert.equal(Number((await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).count('* as n').first()).n), 1);
});

test('ack failure preserves evidence and a fresh outbox worker acknowledges the already received destination without resending', async () => {
    const { createPaymentOutboxService } = await import('../../src/services/paymentOutboxService.js');
    const dto = await release(), c = consumer(adapter());
    await db.raw(`CREATE FUNCTION reject_synthetic_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SECRET'; END $$`);
    await db.raw(`CREATE TRIGGER reject_synthetic_ack BEFORE UPDATE ON outbox_eventos FOR EACH ROW WHEN (NEW.status='CONCLUIDO') EXECUTE FUNCTION reject_synthetic_ack()`);
    try { await assert.rejects(createPaymentOutboxService({ db, deliver: c.deliver, now: clock, leaseMs: 1000 }).processEvent(dto.id)); }
    finally { await db.raw('DROP TRIGGER reject_synthetic_ack ON outbox_eventos'); await db.raw('DROP FUNCTION reject_synthetic_ack()'); }
    assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'RECEBIDA');
    instant = '2026-10-27T15:00:02Z';
    try { await createPaymentOutboxService({ db, deliver: consumer(adapter()).deliver, now: clock }).processEvent(dto.id); }
    finally { instant = undefined; }
    assert.equal((await db('outbox_eventos').where({ id: dto.id }).first()).status, 'CONCLUIDO');
    assert.equal(Number((await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).count('* as n').first()).n), 1);
});

test('migration keeps delivery history forward-only and referentially linked', async () => {
    const dto = await release(); await consumer(adapter()).deliver(dto);
    await assert.rejects(db('outbox_eventos').where({ id: dto.id }).del(), e => ['23001', '23503'].includes(e.code));
    await assert.rejects(db('infinitepay_entregas_tentativas').insert({ chave_unica: 'absent', numero: 1, operacao: 'ENVIO', status: 'ENVIANDO', token: randomUUID() }), { code: '23503' });
    const migration = await import('../../src/database/migrations/20261027000100_entregas_operacionais.js');
    await assert.rejects(migration.down(db), /forward-only/);
});

test('schema rejects partially populated leases and unacknowledged receipt references', async () => {
    for (const extra of [{ locked_by: randomUUID() }, { locked_until: clock() }, { status: 'INCERTA', receipt_id: 'unverified' }, { status: 'INCERTA', recebido_em: clock() }]) {
        const dto = await release();
        await assert.rejects(db('infinitepay_entregas_operacionais').insert({ chave_unica: dto.key, outbox_id: dto.id,
            pedido_id: dto.pedidoId, destino: 'synthetic-kitchen', ...extra }), { code: '23514' });
    }
});

test('failure persisting a verified receipt remains uncertain and recovers by lookup without another send', async () => {
    const dto = await release();
    await db.raw(`CREATE FUNCTION reject_synthetic_delivery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SECRET'; END $$`);
    await db.raw(`CREATE TRIGGER reject_synthetic_delivery_receipt BEFORE UPDATE ON infinitepay_entregas_operacionais FOR EACH ROW WHEN (NEW.status='RECEBIDA') EXECUTE FUNCTION reject_synthetic_delivery_receipt()`);
    try { await assert.rejects(consumer(adapter()).deliver(dto), error('DELIVERY_STORAGE_FAILED')); }
    finally { await db.raw('DROP TRIGGER reject_synthetic_delivery_receipt ON infinitepay_entregas_operacionais'); await db.raw('DROP FUNCTION reject_synthetic_delivery_receipt()'); }
    assert.equal((await db('infinitepay_entregas_operacionais').where({ chave_unica: dto.key }).first()).status, 'INCERTA');
    await consumer(adapter()).recover(dto.key);
    assert.equal(Number((await db('synthetic_receiver').where({ key: dto.key }).count('* as n').first()).n), 1);
    assert.deepEqual((await db('infinitepay_entregas_tentativas').where({ chave_unica: dto.key }).orderBy('numero')).map(x => x.status), ['INCERTA', 'RECEBIDA']);
});
test('a slow ownership query cannot authorize sending after its returned lease has expired',async()=>{
    const dto=await release();
    const delayClock=(_result,query)=>{
        if(/^select/.test(query.sql) && query.sql.includes('infinitepay_entregas_operacionais') && query.sql.includes(' > '))
            instant='2026-10-27T15:00:02Z';
    };
    db.on('query-response',delayClock);
    try {
        await assert.rejects(consumer(adapter()).deliver(dto),error('DELIVERY_LEASE_LOST'));
        assert.equal(Number((await db('synthetic_receiver').where({key:dto.key}).count('* as n').first()).n),0);
    }finally{instant=undefined;db.removeListener('query-response',delayClock);}
});
