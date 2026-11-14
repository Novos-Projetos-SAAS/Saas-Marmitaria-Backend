// Run explicitly against a disposable local cluster, never through application database settings:
// node --experimental-test-module-mocks tests/infinitepay-methods.postgres.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mock } from 'node:test';
import knex from 'knex';
import { up } from '../src/database/migrations/20261114000100_infinitepay_payment_methods.js';

const schema = 'ip_methods_' + randomUUID().replaceAll('-', '');
const localConnection = { host: '127.0.0.1', port: 55437, user: 'infinitepay_test', database: 'postgres', ssl: false };
const db = knex({ client: 'pg', connection: localConnection, searchPath: [schema], pool: { min: 0, max: 5 } });
const notifications = [];
const requests = [];

try {
    const identity = (await db.raw('select current_user, host(inet_server_addr()) as host')).rows[0];
    assert.equal(identity.current_user, 'infinitepay_test');
    assert.equal(identity.host, '127.0.0.1');
    await db.schema.createSchema(schema);
    await db.raw(`
        CREATE TABLE config_infinitepay (id integer primary key, ativo boolean not null, handle text,
            credencial_atual_id integer, assured_installments integer default 1, atualizado_em timestamptz);
        INSERT INTO config_infinitepay VALUES (1, true, 'fixture', 1, 1, now());
        CREATE TABLE infinitepay_credenciais (id integer primary key, handle text);
        INSERT INTO infinitepay_credenciais VALUES (1, 'fixture');
        CREATE TABLE metodos_pagamento (id integer primary key, nome text, codigo text, tipo_financeiro text, ativo boolean);
        INSERT INTO metodos_pagamento VALUES (71, 'Pix', 'PIX', 'PIX', true),
            (92, 'Cartão de Crédito', 'CARTAO_CREDITO', 'CREDITO', true),
            (103, 'Dinheiro', 'DINHEIRO', 'DINHEIRO', true), (114, 'Débito', 'DEBITO', 'DEBITO', true);
        CREATE TABLE pedidos (id serial primary key, nome_cliente text, telefone_cliente text, endereco_cliente text,
            tipo_pedido text, metodo_entrega text, metodo_pagamento_id integer, status text, fluxo_pagamento text,
            checkout_token_hash text unique, valor_total numeric, observacoes text, precisa_troco boolean, troco_para numeric,
            deletado_em timestamptz, liberado_cozinha_em timestamptz, criado_em timestamptz default now(), atualizado_em timestamptz default now());
        CREATE TABLE pagamentos (id bigserial primary key, pedido_id integer, tentativa_numero integer, order_nsu text unique,
            status text, valor_centavos bigint, credencial_id integer, handle_snapshot text, valid_until timestamptz, checkout_payload jsonb,
            checkout_url text, error_code text, transaction_nsu text, invoice_slug text, capture_method text, installments integer,
            valor_base_provider_centavos bigint, valor_pago_provider_centavos bigint, receipt_url text, provider_verified_at timestamptz,
            pago_em timestamptz, criado_em timestamptz default now(), last_checked_at timestamptz, atualizado_em timestamptz default now(), provedor text default 'INFINITEPAY');
        CREATE TABLE logs (tipo text, usuario_id integer, metodo text, endpoint text, acao text, descricao text, payload jsonb);
    `);
    await db.transaction(up);
    let config = await db('config_infinitepay').first();
    assert.equal(config.pix_habilitado, true);
    assert.equal(config.credito_habilitado, true);
    assert.equal(config.handle, 'fixture');
    assert.equal(config.credencial_atual_id, 1);
    const columns = await db('information_schema.columns').where({ table_schema: schema, table_name: 'config_infinitepay' })
        .whereIn('column_name', ['pix_habilitado', 'credito_habilitado']);
    assert.equal(columns.length, 2);
    for (const column of columns) {
        assert.equal(column.data_type, 'boolean');
        assert.equal(column.is_nullable, 'NO');
        assert.equal(column.column_default, 'true');
    }
    await db('config_infinitepay').insert({ id: 2, ativo: false });
    assert.equal((await db('config_infinitepay').where({ id: 2 }).first()).pix_habilitado, true);
    await db('config_infinitepay').where({ id: 2 }).delete();

    mock.module('../src/database/connection.js', { defaultExport: db });
    mock.module('../src/utils/infinitepayCredentials.js', { namedExports: {
        decryptApiKey: () => 'fixture-only', encryptApiKey: () => { throw new Error('Unexpected credential mutation'); }
    } });
    mock.module('../src/utils/pedidosUtils.js', { namedExports: {
        buscarPedidoCompletoPorId: id => db('pedidos').where({ id }).first(), calcularTotalPedido: () => 2400,
        deCentavos: value => value / 100, normalizarTelefone: value => value,
        inserirMarmitasPedido: async ({ checkoutItems }) => { checkoutItems?.push({ description: 'Marmita', price: 2400, quantity: 1 }); return 2400; },
        inserirMarmitasEspeciaisPedido: async () => 0, inserirProdutosPedido: async () => 0,
        selecionarMarmitasJson: () => db.raw("'[]'::json as marmitas"), selecionarProdutosJson: () => db.raw("'[]'::json as produtos"),
        validarLojaAberta: async () => {}, validarMetodoPagamento: (id, trx) => trx('metodos_pagamento').where({ id, ativo: true }).first()
    } });
    const { getInfinitepayConfig, readPublicConfig, updateInfinitepayConfig } = await import('../src/services/infinitepayConfigService.js');
    const { criarPedido, listarPedidosAdmin } = await import('../src/controllers/Pedidos.Controller.js');
    const { confirmPayment } = await import('../src/services/infinitepayPaymentService.js');
    process.env.RENDER_EXTERNAL_URL = 'https://backend.example.invalid';
    process.env.ALLOWED_ORIGINS = 'https://frontend.example.invalid';
    global.io = { to: () => ({ emit: (event, order) => { if (event === 'novo_pedido_recebido') notifications.push(order.id); } }) };
    mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ endpoint: new URL(url).pathname, body: JSON.parse(options.body) });
        return { ok: true, json: async () => new URL(url).pathname === '/links'
            ? { url: 'https://checkout.infinitepay.io/fixture' }
            : { success: true, paid: true, amount: 2400, paid_amount: 2400, capture_method: 'credit_card' } };
    });
    const invoke = async (handler, req) => {
        let result;
        await handler(req, { set() { return this; }, cookie() { return this; }, status() { return this; }, json(body) { result = body; return this; } }, error => { throw error; });
        return result;
    };
    const post = (method, token = randomUUID(), usuario) => invoke(criarPedido, { method: 'POST', originalUrl: '/pedidos', usuario,
        body: { nome_cliente: 'Fixture', telefone_cliente: '11999999999', tipo_pedido: 'Delivery', metodo_entrega: 'Retirada',
            metodo_pagamento_id: method, marmitas: [{ quantidade: 1 }], client_request_id: token } });

    await updateInfinitepayConfig({ pix_habilitado: false, credito_habilitado: true }, db);
    await db.transaction(up);
    assert.equal((await readPublicConfig(db)).pix_habilitado, false);
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import knex from 'knex';
        const db = knex({client: 'pg', connection: ${JSON.stringify(localConnection)}, searchPath: [${JSON.stringify(schema)}]});
        try { console.log(JSON.stringify(await db('config_infinitepay').where({id:1}).first())); } finally { await db.destroy(); }
    `], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).pix_habilitado, false);
    assert.equal(JSON.parse(restarted.stdout).credito_habilitado, true);
    console.log('PASS migration: defaults, NOT NULL, existing configuration, repeated migration and fresh backend process.');

    for (const pix of [true, false]) for (const credit of [true, false]) {
        await updateInfinitepayConfig({ pix_habilitado: pix, credito_habilitado: credit }, db);
        for (const [method, online] of [[71, pix], [92, credit]]) {
            const before = await db('pagamentos').count('* as count').first();
            const result = await post(method);
            assert.equal(result.data.fluxo_pagamento, online ? 'INFINITEPAY' : 'POSTERIOR');
            const after = await db('pagamentos').count('* as count').first();
            assert.equal(Number(after.count) - Number(before.count), online ? 1 : 0);
            const kitchen = await invoke(listarPedidosAdmin, { query: {} });
            assert.equal(kitchen.data.some(order => order.id === result.data.pedido_id), !online);
        }
    }
    console.log('PASS all four combinations: backend decision, charge creation, kitchen visibility, non-fixed method IDs.');

    await updateInfinitepayConfig({ pix_habilitado: true, credito_habilitado: true }, db);
    const held = await db.transaction();
    await getInfinitepayConfig(held, { lock: true });
    const pendingWrite = updateInfinitepayConfig({ pix_habilitado: false }, db);
    // Prove the writer is waiting on a real PostgreSQL lock, without relying on timing alone.
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (!blocked && Date.now() < deadline) {
        const waiting = await db('pg_stat_activity').where({ usename: 'infinitepay_test', wait_event_type: 'Lock' }).first();
        blocked = Boolean(waiting);
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    await held.commit();
    await pendingWrite;

    const writer = await db.transaction();
    await writer('config_infinitepay').where({ id: 1 }).forUpdate().first();
    await writer('config_infinitepay').where({ id: 1 }).update({ pix_habilitado: true });
    const token = randomUUID();
    const creating = post(71, token);
    blocked = false;
    const creationDeadline = Date.now() + 5000;
    while (!blocked && Date.now() < creationDeadline) {
        blocked = Boolean(await db('pg_stat_activity').where({ usename: 'infinitepay_test', wait_event_type: 'Lock' }).first());
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    await writer.commit();
    const created = await creating;
    assert.equal(created.data.fluxo_pagamento, 'INFINITEPAY');
    await updateInfinitepayConfig({ pix_habilitado: false, credito_habilitado: false }, db);
    assert.equal((await post(71, token)).data.fluxo_pagamento, 'INFINITEPAY');
    const payment = await db('pagamentos').where({ pedido_id: created.data.pedido_id }).first();
    assert.equal((await db('pedidos').where({ id: created.data.pedido_id }).first()).liberado_cozinha_em, null);
    const identifiers = { transaction_nsu: randomUUID(), slug: 'fixture-invoice' };
    await Promise.all([confirmPayment(payment.order_nsu, identifiers), confirmPayment(payment.order_nsu, identifiers)]);
    assert.equal(notifications.filter(id => id === created.data.pedido_id).length, 1);
    assert.equal(Number((await db('pagamentos').where({ pedido_id: created.data.pedido_id }).count('* as count').first()).count), 1);
    console.log('PASS real row locks in both directions; existing checkout stays pending; concurrent confirmations release exactly once.');

    const concurrentToken = randomUUID();
    await updateInfinitepayConfig({ pix_habilitado: true }, db);
    const duplicate = await Promise.all([post(71, concurrentToken), post(71, concurrentToken)]);
    assert.equal(duplicate[0].data.pedido_id, duplicate[1].data.pedido_id);
    assert.equal(Number((await db('pagamentos').where({ pedido_id: duplicate[0].data.pedido_id }).count('* as count').first()).count), 1);
    for (const [method, usuario] of [[103], [114], [71, { id: 1 }], [92, { id: 1 }]]) {
        assert.equal((await post(method, randomUUID(), usuario)).data.fluxo_pagamento, 'POSTERIOR');
    }
    console.log('PASS concurrent order idempotency; cash, debit and administrative PDV remain traditional.');
} finally {
    mock.restoreAll();
    delete global.io;
    await db.schema.dropSchemaIfExists(schema, true);
    await db.destroy();
}
