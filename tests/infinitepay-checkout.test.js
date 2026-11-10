import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, mock, test } from 'node:test';
import knex from 'knex';

const sqlBuilder = knex({ client: 'pg' });
let store;
let transactionQueue;
let requests;
let notificationIds;
let provider;
let configurationRead;

function query(builder) {
    const clone = builder.clone.bind(builder);
    builder.clone = () => query(clone());
    // Row and advisory locks are emulated by the serialized transaction queue.
    builder.forUpdate = builder.forShare = builder.transacting = () => builder;
    builder.then = (resolve, reject) => Promise.resolve().then(() => {
        const { sql, bindings, method } = builder.toSQL();
        const statement = store.prepare(sql);
        const params = bindings.map(value => value === undefined ? null :
            typeof value === 'boolean' ? Number(value) : value && typeof value === 'object' ? JSON.stringify(value) : value);
        if (['select', 'first', 'pluck'].includes(method) || /\breturning\b/i.test(sql)) {
            const rows = statement.all(...params).map(row => ({ ...row,
                ...(typeof row.ativo === 'number' ? { ativo: Boolean(row.ativo) } : {}),
                ...(row.checkout_payload ? { checkout_payload: JSON.parse(row.checkout_payload) } : {}) }));
            return method === 'first' ? rows[0] : rows;
        }
        return statement.run(...params).changes;
    }).then(resolve, reject);
    return builder;
}

function connection(table) {
    if (table === 'config_infinitepay' && configurationRead) configurationRead();
    return query(sqlBuilder(table));
}
connection.fn = sqlBuilder.fn;
connection.raw = sqlBuilder.raw.bind(sqlBuilder);
connection.transaction = async action => {
    const previous = transactionQueue;
    let unlock;
    transactionQueue = new Promise(resolve => { unlock = resolve; });
    await previous;
    store.exec('BEGIN');
    let completed = false;
    function finish(sql) {
        store.exec(sql);
        completed = true;
        unlock();
    }
    const trx = Object.assign(table => connection(table), {
        fn: connection.fn,
        raw: async () => {},
        commit: async () => finish('COMMIT'),
        rollback: async () => finish('ROLLBACK'),
        isCompleted: () => completed
    });
    if (!action) return trx;
    try {
        const result = await action(trx);
        await trx.commit();
        return result;
    } catch (error) {
        await trx.rollback();
        throw error;
    }
};

mock.module('../src/database/connection.js', { defaultExport: connection });
mock.module('../src/utils/infinitepayCredentials.js', { namedExports: {
    encryptApiKey: () => { throw new Error('Unexpected credential write'); },
    decryptApiKey: () => 'mock-provider-key'
} });
mock.module('../src/utils/pedidosUtils.js', { namedExports: {
    buscarPedidoCompletoPorId: id => connection('pedidos').where({ id }).first(),
    calcularTotalPedido: () => 2400,
    deCentavos: cents => cents / 100,
    inserirMarmitasPedido: async () => 2400,
    inserirMarmitasEspeciaisPedido: async () => 0,
    inserirProdutosPedido: async () => 0,
    normalizarTelefone: value => value,
    selecionarMarmitasJson: () => connection.raw("'[]' as marmitas"),
    selecionarProdutosJson: () => connection.raw("'[]' as produtos"),
    validarLojaAberta: async () => {},
    validarMetodoPagamento: async (id, trx) => {
        const method = await trx('metodos_pagamento').where({ id, ativo: 1 }).first();
        assert.ok(method, 'test method must exist');
        return method;
    }
} });

const { criarPedido, listarPedidosAdmin } = await import('../src/controllers/Pedidos.Controller.js');
const { listarMetodosDePagamentosAtivos } = await import('../src/controllers/MetodosPagamentos.Controller.js');
const { default: pagamentos, legacyInfinitepayWebhook } = await import('../src/routes/Pagamentos.Routes.js');
const { checkoutTokenHash } = await import('../src/services/infinitepayPaymentService.js');
const browserConfirm = pagamentos.stack.find(layer => layer.route?.path === '/pedidos/:id/confirmar').route.stack.at(-1).handle;

function enabled(ativo) {
    // SQLite stores booleans as integers; normalize this row the same way pg does.
    store.prepare('UPDATE config_infinitepay SET ativo = ?').run(ativo ? 1 : 0);
}

function providerResult(paid = true) {
    return { success: true, paid, amount: 2400, paid_amount: 2450, capture_method: 'pix' };
}

beforeEach(() => {
    transactionQueue = Promise.resolve();
    configurationRead = null;
    notificationIds = [];
    requests = [];
    store = new DatabaseSync(':memory:');
    store.exec(`
        CREATE TABLE metodos_pagamento (id INTEGER PRIMARY KEY, nome TEXT, codigo TEXT, tipo_financeiro TEXT, ativo INTEGER, deletado_em TEXT);
        INSERT INTO metodos_pagamento VALUES (1, 'Pix', NULL, 'OUTRO', 1, NULL),
            (2, 'Cartão de Crédito', NULL, 'OUTRO', 1, NULL), (3, 'Dinheiro', NULL, 'OUTRO', 1, NULL),
            (4, 'Cartão na entrega', 'CREDITO_ENTREGA', 'CREDITO', 1, NULL),
            (5, 'InfinitePay (Pix ou cartão)', 'INFINITEPAY', 'OUTRO', 1, NULL),
            (6, 'Cartão de Débito', 'CARTAO_DEBITO', 'DEBITO', 1, NULL);
        CREATE TABLE config_infinitepay (id INTEGER PRIMARY KEY, ativo INTEGER, credencial_atual_id INTEGER, handle TEXT, assured_installments INTEGER);
        INSERT INTO config_infinitepay VALUES (1, 1, 1, 'loja-teste', 1);
        CREATE TABLE infinitepay_credenciais (id INTEGER PRIMARY KEY, handle TEXT);
        INSERT INTO infinitepay_credenciais VALUES (1, 'loja-teste');
        CREATE TABLE pedidos (id INTEGER PRIMARY KEY, nome_cliente TEXT, telefone_cliente TEXT, endereco_cliente TEXT,
            tipo_pedido TEXT, metodo_entrega TEXT, metodo_pagamento_id INTEGER, status TEXT, fluxo_pagamento TEXT,
            checkout_token_hash TEXT UNIQUE, valor_total REAL, observacoes TEXT, precisa_troco INTEGER, troco_para REAL,
            deletado_em TEXT, liberado_cozinha_em TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE pagamentos (id INTEGER PRIMARY KEY, pedido_id INTEGER, tentativa_numero INTEGER, order_nsu TEXT UNIQUE,
            status TEXT, valor_centavos INTEGER, credencial_id INTEGER, handle_snapshot TEXT, valid_until TEXT, checkout_payload TEXT,
            checkout_url TEXT, error_code TEXT, transaction_nsu TEXT, invoice_slug TEXT, capture_method TEXT, installments INTEGER,
            valor_base_provider_centavos INTEGER, valor_pago_provider_centavos INTEGER, receipt_url TEXT, provider_verified_at TEXT,
            pago_em TEXT, last_checked_at TEXT, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP, provedor TEXT DEFAULT 'INFINITEPAY');
        CREATE TABLE logs (tipo TEXT, usuario_id INTEGER, metodo TEXT, endpoint TEXT, acao TEXT, descricao TEXT, payload TEXT);
    `);
    process.env.RENDER_EXTERNAL_URL = 'https://backend.example.invalid';
    process.env.ALLOWED_ORIGINS = 'https://frontend.example.invalid';
    global.io = { to: () => ({ emit: (event, order) => {
        if (event === 'novo_pedido_recebido') notificationIds.push(order.id);
    } }) };
    provider = endpoint => endpoint === '/links'
        ? { url: 'https://checkout.infinitepay.io/checkout-ficticio' }
        : providerResult();
    mock.method(globalThis, 'fetch', async (url, options) => {
        const endpoint = new URL(url).pathname;
        requests.push({ endpoint, payload: JSON.parse(options.body) });
        return { ok: true, json: async () => provider(endpoint) };
    });
});

afterEach(() => {
    mock.restoreAll();
    delete global.io;
    store.close();
});

async function invoke(handler, req = {}) {
    let code = 200;
    let body;
    const res = { set() { return this; }, status(value) { code = value; return this; }, json(value) { body = value; return this; } };
    await handler(req, res, error => { throw error; });
    return { code, body };
}

function orderBody(method, token = randomUUID()) {
    return { nome_cliente: 'Cliente de teste', telefone_cliente: '11999999999', tipo_pedido: 'Delivery',
        metodo_entrega: 'Retirada', metodo_pagamento_id: method, marmitas: [{ quantidade: 1 }], client_request_id: token };
}

const post = (body, extra) => invoke(criarPedido, { method: 'POST', originalUrl: '/pedidos', body, ...extra });
const kitchen = async () => (await invoke(listarPedidosAdmin, { query: {} })).body.data;
const rows = table => store.prepare('SELECT * FROM ' + table).all();
const identifiers = payment => ({ order_nsu: payment.order_nsu, transaction_nsu: 'tx-test', invoice_slug: 'invoice-test' });
const webhook = payment => invoke(legacyInfinitepayWebhook, { body: identifiers(payment) });

for (const active of [true, false]) {
    for (const [method, options] of [[1, ['pix', 'credit_card']], [2, ['credit_card']]]) {
        test(`ativação=${active} modalidade=${method} respeita o fluxo e as opções do provedor`, async () => {
            enabled(active);
            const input = orderBody(method);
            const response = await post(input);
            const { data } = response.body;
            assert.equal(response.code, 201);
            assert.equal(rows('pedidos')[0].metodo_pagamento_id, method);
            assert.equal(rows('pedidos')[0].checkout_token_hash, checkoutTokenHash(input.client_request_id));
            assert.equal(data.fluxo_pagamento, active ? 'INFINITEPAY' : 'POSTERIOR');
            assert.equal(rows('pagamentos').length, active ? 1 : 0);
            assert.equal(requests.length, active ? 1 : 0);
            if (active) {
                assert.equal(data.checkout_url, 'https://checkout.infinitepay.io/checkout-ficticio');
                assert.equal(data.access_token, input.client_request_id);
                assert.deepEqual(requests[0].payload.options.payment_methods_enabled, options);
                assert.equal(data.pagamento_status, 'PENDENTE');
            }
            assert.equal((await kitchen()).length, active ? 0 : 1);
            assert.equal(notificationIds.length, active ? 0 : 1);
        });
    }
}

test('meios restantes e PDV usam fluxo tradicional independente da configuração', async () => {
    configurationRead = () => { throw new Error('fluxo tradicional não deveria consultar a configuração'); };
    for (const method of [3, 4, 6]) assert.equal((await post(orderBody(method))).body.data.fluxo_pagamento, 'POSTERIOR');
    assert.equal((await post(orderBody(2), { usuario: { id: 1 } })).body.data.fluxo_pagamento, 'POSTERIOR');
    assert.equal(requests.length, 0);
    assert.equal(notificationIds.length, 4);
});

test('modalidade redundante não aparece e é rejeitada em novos pedidos', async () => {
    const result = await invoke(listarMetodosDePagamentosAtivos);
    assert.deepEqual(result.body.data.map(method => method.id).sort(), [1, 2, 3, 4, 6]);
    await assert.rejects(post(orderBody(5)), { statusCode: 400 });
    assert.equal(rows('pedidos').length, 0);
});

test('checkout incerto não libera o pedido nem reenvia cobrança quando desativado', async () => {
    provider = () => { throw new Error('falha simulada na resposta'); };
    const input = orderBody(1);
    const first = await post(input);
    assert.equal(first.code, 202);
    assert.equal(first.body.data.fluxo_pagamento, 'INFINITEPAY');
    assert.equal(first.body.data.checkout_url, null);
    assert.ok(first.body.data.checkout_error);
    enabled(false);
    const retry = await post(input);
    assert.equal(retry.body.data.reused, true);
    assert.equal(retry.body.data.pedido_id, first.body.data.pedido_id);
    assert.equal(retry.body.data.fluxo_pagamento, 'INFINITEPAY');
    assert.equal(rows('pagamentos')[0].status, 'INCERTA');
    assert.equal(requests.length, 1);
    assert.equal((await kitchen()).length, 0);
    assert.deepEqual(notificationIds, []);
});

test('tentativa criada antes da desativação conserva a cobrança e confirma só uma vez', async () => {
    const first = await post(orderBody(1));
    const payment = rows('pagamentos')[0];
    enabled(false);
    assert.equal((await kitchen()).length, 0);
    await webhook(payment);
    await webhook(payment);
    assert.equal(rows('pagamentos')[0].status, 'PAGA');
    assert.equal((await kitchen()).length, 1);
    assert.deepEqual(notificationIds, [first.body.data.pedido_id]);
    assert.deepEqual(requests.map(req => req.endpoint), ['/links', '/payment_check']);
});

test('retorno do navegador e webhook com pagamento recusado não liberam produção', async () => {
    provider = endpoint => endpoint === '/links' ? { url: 'https://checkout.infinitepay.io/checkout-ficticio' } : providerResult(false);
    const input = orderBody(1);
    const first = await post(input);
    const payment = rows('pagamentos')[0];
    const result = await invoke(browserConfirm, { params: { id: first.body.data.pedido_id },
        get: () => 'Bearer ' + input.client_request_id, body: { ...identifiers(payment), paid: true } });
    assert.equal(result.body.data.pagamento_status, 'PENDENTE');
    await webhook(payment);
    assert.equal(rows('pagamentos')[0].status, 'AGUARDANDO');
    assert.equal((await kitchen()).length, 0);
    assert.deepEqual(notificationIds, []);
});

test('pedido cancelado com pagamento validado não entra na produção', async () => {
    await post(orderBody(1));
    store.exec("UPDATE pedidos SET status = 'Cancelado'");
    await webhook(rows('pagamentos')[0]);
    assert.equal(rows('pagamentos')[0].status, 'PAGA');
    assert.equal(rows('pedidos')[0].liberado_cozinha_em, null);
    assert.equal((await kitchen()).length, 0);
    assert.deepEqual(notificationIds, []);
});

test('cliques concorrentes reutilizam o identificador e geram um pedido e uma cobrança', async () => {
    const input = orderBody(2);
    const results = await Promise.all([post(input), post(input)]);
    assert.equal(results[0].body.data.pedido_id, results[1].body.data.pedido_id);
    assert.equal(results.filter(result => result.body.data.reused).length, 1);
    assert.equal(rows('pedidos').length, 1);
    assert.equal(rows('pagamentos').length, 1);
    assert.equal(requests.filter(req => req.endpoint === '/links').length, 1);
});

test('pedido tradicional já criado conserva o fluxo após ativação, sem novo evento', async () => {
    enabled(false);
    const input = orderBody(2);
    const first = await post(input);
    enabled(true);
    const retry = await post(input);
    assert.equal(retry.body.data.pedido_id, first.body.data.pedido_id);
    assert.equal(retry.body.data.reused, true);
    assert.equal(retry.body.data.fluxo_pagamento, 'POSTERIOR');
    assert.equal(rows('pedidos').length, 1);
    assert.equal(rows('pagamentos').length, 0);
    assert.deepEqual(notificationIds, [first.body.data.pedido_id]);
});

test('parâmetro enviado pelo cliente não desativa o checkout e token é obrigatório online', async () => {
    const input = { ...orderBody(2), infinitepay_ativo: false, fluxo_pagamento: 'POSTERIOR' };
    await assert.rejects(post({ ...input, client_request_id: undefined }), { statusCode: 400 });
    const response = await post(input);
    assert.equal(response.body.data.fluxo_pagamento, 'INFINITEPAY');
    assert.equal((await kitchen()).length, 0);
});

test('configuração administrativa ausente ou incompleta bloqueia a tentativa elegível', async () => {
    store.exec('UPDATE config_infinitepay SET credencial_atual_id = NULL');
    await assert.rejects(post(orderBody(1)), { statusCode: 503 });
    store.exec('DELETE FROM config_infinitepay');
    await assert.rejects(post(orderBody(2)), { statusCode: 503 });
    assert.equal(rows('pedidos').length, 0);
    assert.equal(rows('pagamentos').length, 0);
    assert.equal(requests.length, 0);
    assert.deepEqual(notificationIds, []);
});
