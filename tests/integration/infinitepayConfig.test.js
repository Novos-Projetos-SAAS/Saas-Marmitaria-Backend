import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createTestDatabase, historicalOrder } from '../helpers/testDatabase.js';
let f, server, base, appDb;
let legacyPayload;
const origin = 'http://localhost:3000';
const secret = 'SYNTHETIC_API_KEY_NEVER_LOG';
const sessions = new Map();
function cookie(id = 1, cargo = 'admin') {
    const key = id + ':' + cargo;
    if (!sessions.has(key)) sessions.set(key, 'token=' + jwt.sign({ id, cargo }, process.env.JWT_SECRET, { expiresIn: '5m' }));
    return sessions.get(key);
}
async function request(path = '/configuracoes/infinitepay', { id = 1, method = 'GET', body, headers = {} } = {}) {
    return fetch(base + path, { method, headers: { Cookie: cookie(id), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function write(body, options = {}) {
    const r = await request();
    const { csrf_token } = await r.json();
    return request('/configuracoes/infinitepay', { method: 'PUT', body, headers: { Origin: origin, 'X-Infinitepay-CSRF': csrf_token }, ...options });
}
before(async () => {
    f = await createTestDatabase();
    await f.db.migrate.latest();
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_SCHEMA = f.schema;
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.INFINITEPAY_CHECKOUT_ENABLED = 'false';
    process.env.ALLOWED_ORIGINS = origin;
    await f.db('niveis_acesso').insert([{ id: 1, nome: 'admin', descricao: 'Sintético' }, { id: 2, nome: 'atendente', descricao: 'Sintético' }]);
    await f.db('usuarios').insert([1,2,3,4].map(id => ({ id, nome: 'Usuário sintético', email: 'sintetico'+id+'@invalid.test',
        senha_hash: 'synthetic-no-login', nivel_acesso_id: id === 1 ? 1 : 2, ativo: id !== 4 })));
    const permission = await f.db('permissoes').where({ nome: 'pagamentos.configurar' }).first();
    await f.db('permissoes_usuarios').insert({ usuario_id: 2, permissao_id: permission.id });
    await f.db('status_loja').insert({ id: 1, esta_aberta: true });
    await f.db('metodos_pagamento').insert([
        { id: 31, nome: 'Dinheiro sintético' }, { id: 32, nome: 'Débito sintético' },
        { id: 33, nome: 'Pix sintético' }, { id: 34, nome: 'Crédito sintético' }
    ]);
    const [category] = await f.db('categorias_alimentos').insert({ nome: 'Categoria sintética', limite_escolhas: 1 }).returning('*');
    const [food] = await f.db('alimentos').insert({ nome: 'Arroz sintético', categoria_id: category.id, disponivel_hoje: true }).returning('*');
    const [size] = await f.db('tamanhos_marmitas').insert({ nome: 'M sintética', preco_base: 20 }).returning('*');
    legacyPayload = { nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
        endereco_cliente: 'Rua sintética', tipo_pedido: 'Remoto', metodo_entrega: 'Entrega',
        marmitas: [{ tamanho_id: size.id, quantidade: 1, alimentos: [food.id] }] };
    const { default: app } = await import('../../src/app.js');
    appDb = (await import('../../src/database/connection.js')).default;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (appDb) await appDb.destroy();
    if (f) await f.close();
});

test('config GET enforces current active user and permission, not stale JWT admin claims', async () => {
    assert.equal((await fetch(base + '/configuracoes/infinitepay')).status, 401);
    assert.equal((await request(undefined, { id: 3 })).status, 403);
    assert.equal((await request(undefined, { id: 4 })).status, 401);
    assert.equal((await request(undefined, { id: 2 })).status, 200);
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.json();
    assert.deepEqual(body.data, { handle: null, ativo: false, assured_installments: 1, has_api_key: false });
    assert.equal(typeof body.csrf_token, 'string');
});
test('writes require exact trusted origin, session-bound CSRF token and JSON', async () => {
    assert.equal((await request(undefined, { method: 'PUT', body: { ativo: false } })).status, 403);
    assert.equal((await request(undefined, { method: 'PUT', body: { ativo: false }, headers: { Origin: origin, 'X-Infinitepay-CSRF': 'bad' } })).status, 403);
    const token = (await (await request()).json()).csrf_token;
    assert.equal((await request(undefined, { id: 2, method: 'PUT', body: { ativo: false }, headers: { Origin: origin, 'X-Infinitepay-CSRF': token } })).status, 403);
    assert.equal((await request(undefined, { method: 'PUT', body: { ativo: false }, headers: { Origin: 'null', 'X-Infinitepay-CSRF': token } })).status, 403);
});

test('non-JSON writes return 415 without changing config, credentials or audit actions', async () => {
    const token = (await (await request()).json()).csrf_token;
    const configBefore = await f.db('config_infinitepay').select('*');
    const credentialsBefore = await f.db('infinitepay_credenciais').select('*');
    const actionsBefore = await f.db('logs').where({ acao: 'INFINITEPAY.CONFIGURAR' }).select('*');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
        const response = await request(undefined, { method: 'PUT', body: { ativo: false, handle: 'SHOULD_NOT_PERSIST' },
            headers: { Origin: origin, 'X-Infinitepay-CSRF': token, 'Content-Type': contentType } });
        assert.equal(response.status, 415, contentType);
    }
    const missingType = await fetch(base + '/configuracoes/infinitepay', { method: 'PUT',
        headers: { Cookie: cookie(), Origin: origin, 'X-Infinitepay-CSRF': token },
        body: Buffer.from('{"ativo":false}') });
    assert.equal(missingType.status, 415);
    assert.deepEqual(await f.db('config_infinitepay').select('*'), configBefore);
    assert.deepEqual(await f.db('infinitepay_credenciais').select('*'), credentialsBefore);
    assert.deepEqual(await f.db('logs').where({ acao: 'INFINITEPAY.CONFIGURAR' }).select('*'), actionsBefore);
});

test('database failure before route selection logs the static mount without request secrets', async () => {
    const sentinel = 'PRE_ROUTE_SECRET_MUST_NOT_APPEAR';
    const captured = [];
    const originalError = console.error;
    let response, renamed = false;
    console.error = (...args) => captured.push(args);
    try {
        // Fail the real current-user query, not a mock, in this fixture schema only.
        await f.db.schema.renameTable('usuarios', 'usuarios_ip_failure');
        renamed = true;
        response = await request('/configuracoes/infinitepay?token=' + sentinel,
            { headers: { 'X-Api-Key': sentinel, Authorization: sentinel } });
    } finally {
        if (renamed) await f.db.schema.renameTable('usuarios_ip_failure', 'usuarios');
        console.error = originalError;
    }
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { status: 'error', message: 'Erro interno no servidor' });
    const logged = await f.db('logs').where({ acao: 'SISTEMA.ERRO' }).orderBy('id', 'desc').first();
    assert.equal(logged.endpoint, '/configuracoes/infinitepay');
    assert.deepEqual(captured, [['Erro interno na API', { method: 'GET', route: '/configuracoes/infinitepay', usuario_id: 1 }]]);
    assert.equal(JSON.stringify({ logged, captured }).includes(sentinel), false);
});

test('database failure after route selection logs the template without query secrets', async () => {
    const sentinel = 'POST_ROUTE_SECRET_MUST_NOT_APPEAR';
    const captured = [];
    const originalError = console.error;
    let response, renamed = false;
    console.error = (...args) => captured.push(args);
    try {
        await f.db.schema.renameTable('config_infinitepay', 'config_infinitepay_failure');
        renamed = true;
        response = await request('/configuracoes/infinitepay?api_key=' + sentinel,
            { headers: { Authorization: sentinel } });
    } finally {
        if (renamed) await f.db.schema.renameTable('config_infinitepay_failure', 'config_infinitepay');
        console.error = originalError;
    }
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { status: 'error', message: 'Erro interno no servidor' });
    const logged = await f.db('logs').where({ acao: 'SISTEMA.ERRO' }).orderBy('id', 'desc').first();
    assert.equal(logged.endpoint, '/configuracoes/infinitepay/');
    assert.deepEqual(captured, [['Erro interno na API', { method: 'GET', route: '/configuracoes/infinitepay/', usuario_id: 1 }]]);
    assert.equal(JSON.stringify({ logged, captured }).includes(sentinel), false);
});
test('config stores ciphertext, versioned account context and returns no key; Phase 1 cannot activate', async () => {
    const r = await write({ handle: '$synthetic-store', api_key: secret, assured_installments: 0 });
    assert.equal(r.status, 200);
    const value = await r.json();
    assert.deepEqual(value.data, { handle: 'synthetic-store', ativo: false, assured_installments: 0, has_api_key: true });
    assert.equal(JSON.stringify(value).includes(secret), false);
    const old = await f.db('infinitepay_credenciais').first();
    const historical = await historicalOrder(f.db,{id:701,methodId:99});
    const [attempt] = await f.db('pagamentos').insert({pedido_id:historical.id,tentativa_numero:1,order_nsu:'SYNTHETIC_HISTORICAL',
        status:'AGUARDANDO',valor_centavos:2000,valid_until:'2030-01-01',credencial_id:old.id,handle_snapshot:old.handle}).returning('*');
    assert.notEqual(old.api_key_ciphertext, secret);
    assert.equal((await write({ ativo: true })).status, 400);
    assert.equal((await write({ handle: 'other-store' })).status, 400);
    assert.equal((await write({ assured_installments: 13 })).status, 400);
    assert.equal((await write({ assured_installments: 1.5 })).status, 400);
    assert.equal((await write({ assured_installments: 12, ignored_secret: secret })).status, 400);
    assert.equal((await write({ handle: 'other-store', api_key: 'SYNTHETIC_REPLACEMENT' })).status, 200);
    assert.equal(await f.db('infinitepay_credenciais').count('* as n').first().then(r => Number(r.n)), 2);
    assert.equal((await f.db('infinitepay_credenciais').where({ id: old.id }).first()).handle, 'synthetic-store');
    const historicalContext = await f.db('pagamentos as p').join('infinitepay_credenciais as c','c.id','p.credencial_id')
        .where('p.id',attempt.id).select('p.handle_snapshot','c.handle').first();
    assert.deepEqual(historicalContext,{handle_snapshot:'synthetic-store',handle:'synthetic-store'});
    await assert.rejects(f.db('infinitepay_credenciais').where({ id: old.id }).update({ handle: 'changed' }), /imutável/);
    assert.equal((await write({ remove_api_key: true })).status, 200);
    assert.equal((await (await request()).json()).data.has_api_key, false);
});
test('database and encryption errors leak no key in responses, console or persisted audit', async () => {
    const messages = [];
    const originalError = console.error;
    console.error = (...args) => messages.push(JSON.stringify(args));
    try {
        process.env.INFINITEPAY_ENCRYPTION_KEY = secret;
        const r = await write({ handle: 'synthetic-store', api_key: secret });
        assert.equal(r.status, 500);
        assert.equal((await r.text()).includes(secret), false);
        process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
        await f.db.raw(`CREATE FUNCTION fail_ip_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_API_KEY_NEVER_LOG'; END; $$`);
        await f.db.raw('CREATE TRIGGER fail_ip_audit BEFORE INSERT ON infinitepay_credenciais FOR EACH ROW EXECUTE FUNCTION fail_ip_audit()');
        const failed = await write({ handle: 'synthetic-store', api_key: secret });
        assert.equal(failed.status, 500);
        assert.equal((await failed.text()).includes(secret), false);
        await f.db.raw('DROP TRIGGER fail_ip_audit ON infinitepay_credenciais');
        const logs = await f.db('logs').select('*');
        assert.equal(JSON.stringify(logs).includes(secret), false);
        assert.equal(messages.join('').includes(secret), false);
        const errorLogs = logs.filter(row=>row.acao==='SISTEMA.ERRO');
        const controllerErrors = errorLogs.filter(row=>row.metodo==='PUT');
        assert.equal(controllerErrors.length,2);
        assert.equal(controllerErrors.every(row=>row.endpoint==='/configuracoes/infinitepay/'),true);
    } finally { console.error = originalError; }
});

test('known expired and invalid session messages remain actionable without exposing JWT values', async () => {
    const expired = jwt.sign({id:1,cargo:'admin'},process.env.JWT_SECRET,{expiresIn:-60});
    const r = await request(undefined,{headers:{Cookie:'token='+expired}});
    assert.equal(r.status,401);
    assert.equal((await r.json()).message,'Sua sessão expirou. Por favor, faça login novamente.');
    const invalid = await request(undefined,{headers:{Cookie:'token=synthetic-invalid-token'}});
    assert.equal(invalid.status,401);
    assert.equal((await invalid.json()).message,'Token inválido.');
});

test('configuration accepts bounded single-line handles without assuming undocumented provider syntax', async () => {
    const r = await write({handle:'lojação'});
    assert.equal(r.status,200);
    assert.equal((await r.json()).data.handle,'lojação');
    assert.equal((await write({handle:'store\ninvalid'})).status,400);
});

test('company settings reject financial secrets before persistence and keep the printing configuration contract', async () => {
    const company = { nome_proprietario: 'Titular sintético', razao_social: 'Empresa sintética', nome_fantasia: 'Loja sintética',
        telefone_empresa: '11999999999', cnpj: null, cep: '00000000', logradouro: 'Rua sintética',
        numero: '1', bairro: 'Centro', cidade: 'Cidade', estado: 'SP', imprimir_automaticamente: false, nome_impressora: null };
    const r = await request('/configuracoes/empresa', { method: 'PUT', body: { ...company, api_key: secret } });
    assert.equal(r.status, 400);
    assert.equal((await r.text()).includes(secret), false);
    const p = await f.db('permissoes').insert({ nome: 'empresa.configurar', descricao: 'Sintético' }).onConflict('nome').ignore();
    const saved = await request('/configuracoes/empresa', { method: 'PUT', body: company });
    assert.equal(saved.status, 201);
    assert.equal((await saved.json()).data.imprimir_automaticamente, false);
    assert.equal(JSON.stringify(await f.db('logs').select('*')).includes('Titular sintético'), false);
});

test('legacy company GET and full-object update preserve automatic printing and printer selection', async () => {
    await f.db('dados_empresa').where({ id: 1 }).update({
        imprimir_automaticamente: true, nome_impressora: 'IMPRESSORA_SINTETICA_80MM',
        nome_fantasia: 'Loja anterior', complemento: 'Sala 2'
    });
    const before = await f.db('dados_empresa').where({ id: 1 }).first();
    const read = await request('/configuracoes/empresa');
    assert.equal(read.status, 200);
    const form = (await read.json()).data;
    assert.equal(form.imprimir_automaticamente, true);
    assert.equal(form.nome_impressora, 'IMPRESSORA_SINTETICA_80MM');
    const saved = await request('/configuracoes/empresa', { method: 'PUT', body: {
        ...form, id: 999, criado_em: '1999-01-01T00:00:00.000Z', atualizado_em: '1999-01-01T00:00:00.000Z',
        nome_fantasia: 'Loja atualizada'
    } });
    assert.equal(saved.status, 200);
    const result = (await saved.json()).data;
    assert.equal(result.id, 1);
    assert.equal(result.imprimir_automaticamente, true);
    assert.equal(result.nome_impressora, 'IMPRESSORA_SINTETICA_80MM');
    assert.equal(result.nome_fantasia, 'Loja atualizada');
    const after = await f.db('dados_empresa').where({ id: 1 }).first();
    const { atualizado_em: oldUpdate, nome_fantasia: oldName, ...oldStable } = before;
    const { atualizado_em: newUpdate, nome_fantasia: newName, ...newStable } = after;
    assert.deepEqual(newStable, oldStable);
    assert.notEqual(newUpdate.toISOString(), '1999-01-01T00:00:00.000Z');
    assert.equal((await f.db('dados_empresa').count('* as n').first()).n, '1');
    const readBack = (await (await request('/configuracoes/empresa')).json()).data;
    assert.equal(readBack.imprimir_automaticamente, true);
    assert.equal(readBack.nome_impressora, 'IMPRESSORA_SINTETICA_80MM');
});

test('remote cash/debit and all four assisted payment methods retain prices, change and immediate kitchen events', async () => {
    const events = [];
    global.io = { to: () => ({ emit: (event, data) => events.push({ event, data }) }) };
    try {
        const { applyVerifiedPaymentMethodMap } = await import('../../src/services/paymentMethodClassification.js');
        await applyVerifiedPaymentMethodMap(f.db, [
            { id:31,nome_esperado:'Dinheiro sintético',codigo:'DINHEIRO',tipo_financeiro:'DINHEIRO' },
            { id:32,nome_esperado:'Débito sintético',codigo:'DEBITO',tipo_financeiro:'DEBITO' },
            { id:33,nome_esperado:'Pix sintético',codigo:'PIX',tipo_financeiro:'PIX' },
            { id:34,nome_esperado:'Crédito sintético',codigo:'CREDITO',tipo_financeiro:'CREDITO' }
        ]);
        const counts = await f.db('pagamentos').count('* as n').first();
        for (const [channel, method] of [['Remoto',31],['Remoto',32],['Presencial',31],['Presencial',32],['Presencial',33],['Presencial',34]]) {
            const payload = { ...legacyPayload, tipo_pedido: channel, metodo_pagamento_id: method,
                precisa_troco: method === 31, troco_para: method === 31 ? 50 : null };
            const path = channel === 'Presencial' ? '/pedidos/admin' : '/pedidos';
            const response = channel === 'Presencial' ? await request(path,{method:'POST',body:payload}) :
                await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            assert.equal(response.status,201);
            const body = await response.json();
            assert.equal(body.data.total,20);
            const row = await f.db('pedidos').where({id:body.data.pedido_id}).first();
            assert.equal(row.fluxo_pagamento,'POSTERIOR');
            assert.equal(row.status,'Pendente');
            assert.equal(row.metodo_pagamento_id,method);
            assert.equal(row.tipo_pedido,channel);
            assert.equal(row.liberado_cozinha_em,null);
            assert.equal(row.client_request_id,null);
            assert.equal(row.client_payload_hash,null);
            assert.equal(row.precisa_troco,method===31);
            assert.equal(row.troco_para,method===31?'50.00':null);
        }
        assert.equal(events.length,6);
        assert.equal(events.every(e=>e.event==='novo_pedido_recebido' && Number(e.data.valor_total)===20),true);
        assert.deepEqual(await f.db('pagamentos').count('* as n').first(),counts);
        assert.equal(await f.db('outbox_eventos').count('* as n').first().then(r=>Number(r.n)),0);
        const methods = await (await fetch(base+'/metodos-pagamentos')).json();
        assert.equal(methods.data.find(m=>m.id===31).codigo,'DINHEIRO');
    } finally { delete global.io; }
});

test('administrative creation still requires a session and the legacy order permission', async () => {
    const before = await f.db('pedidos').select('*').orderBy('id');
    const events = [];
    global.io = { to: () => ({ emit: (...args) => events.push(args) }) };
    try {
        const payload = { ...legacyPayload, tipo_pedido: 'Presencial', metodo_pagamento_id: 31 };
        const anonymous = await fetch(base + '/pedidos/admin', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        assert.equal(anonymous.status, 401);
        const denied = await request('/pedidos/admin', { method: 'POST', body: payload,
            headers: { Cookie: cookie(3, 'atendente') } });
        assert.equal(denied.status, 403);
        assert.deepEqual(await f.db('pedidos').select('*').orderBy('id'), before);
        assert.deepEqual(events, []);
    } finally { delete global.io; }
});

for (const [label, methodId] of [['cash', 31], ['debit', 32]]) {
    test('administrative pickup with ' + label + ' preserves items, total and immediate kitchen delivery', async () => {
        const events = [];
        const financialBefore = await f.db('pagamentos').select('*').orderBy('id');
        const outboxBefore = await f.db('outbox_eventos').select('*').orderBy('id');
        global.io = { to: room => ({ emit: (event, data) => events.push({ room, event, data }) }) };
        try {
            const response = await request('/pedidos/admin', { method: 'POST', body: {
                ...legacyPayload, tipo_pedido: 'Presencial', metodo_entrega: 'Retirada',
                metodo_pagamento_id: methodId, precisa_troco: false, troco_para: null,
                marmitas: [{ ...legacyPayload.marmitas[0], quantidade: 2 }]
            } });
            assert.equal(response.status, 201);
            const result = (await response.json()).data;
            assert.equal(result.total, 40);
            const order = await f.db('pedidos').where({ id: result.pedido_id }).first();
            assert.equal(order.metodo_pagamento_id, methodId);
            assert.equal(order.tipo_pedido, 'Presencial');
            assert.equal(order.metodo_entrega, 'Retirada');
            assert.equal(order.endereco_cliente, null);
            assert.equal(order.valor_total, '40.00');
            assert.equal(order.status, 'Pendente');
            assert.equal(order.fluxo_pagamento, 'POSTERIOR');
            assert.equal(order.liberado_cozinha_em, null);
            assert.equal(order.precisa_troco, false);
            assert.equal(order.troco_para, null);
            const items = await f.db('itens_pedido').where({ pedido_id: order.id });
            assert.equal(items.length, 1);
            assert.equal(items[0].quantidade, 2);
            assert.equal(items[0].preco_unitario, '20.00');
            assert.equal(items[0].subtotal, '40.00');
            const composition = await f.db('composicao_item_pedido').where({ item_pedido_id: items[0].id });
            assert.deepEqual(composition.map(row => row.alimento_id), legacyPayload.marmitas[0].alimentos);
            assert.equal(events.length, 1);
            assert.equal(events[0].event, 'novo_pedido_recebido');
            assert.equal(Number(events[0].data.valor_total), 40);
            assert.deepEqual(await f.db('pagamentos').select('*').orderBy('id'), financialBefore);
            assert.deepEqual(await f.db('outbox_eventos').select('*').orderBy('id'), outboxBefore);
        } finally { delete global.io; }
    });
}

test('closed shop and unavailable food retain conflict codes without creating orders or kitchen events', async () => {
    const count = await f.db('pedidos').count('* as n').first();
    await f.db('status_loja').where({id:1}).update({esta_aberta:false});
    const closed = await request('/pedidos',{method:'POST',body:{...legacyPayload,metodo_pagamento_id:31}});
    assert.equal(closed.status,409);
    assert.equal((await closed.json()).code,'LOJA_FECHADA');
    await f.db('status_loja').where({id:1}).update({esta_aberta:true});
    await f.db('alimentos').update({disponivel_hoje:false});
    const food = await request('/pedidos',{method:'POST',body:{...legacyPayload,metodo_pagamento_id:31}});
    assert.equal(food.status,409);
    assert.equal((await food.json()).code,'ALIMENTOS_INDISPONIVEIS');
    assert.deepEqual(await f.db('pedidos').count('* as n').first(),count);
    await f.db('alimentos').update({disponivel_hoje:true});
});

test('RBAC migration is idempotent and does not grant financial access to ordinary staff', async () => {
    const migration = await import('../../src/database/migrations/20261022000400_infinitepay_permissoes.js');
    await migration.up(f.db);
    await migration.up(f.db);
    assert.equal(await f.db('permissoes_usuarios').where({usuario_id:1}).count('* as n').first().then(r=>Number(r.n)),3);
    assert.equal(await f.db('permissoes_usuarios').where({usuario_id:3}).count('* as n').first().then(r=>Number(r.n)),0);
    const r = await request(undefined,{id:2});
    const {csrf_token} = await r.json();
    const allowed = await request(undefined,{id:2,method:'PUT',body:{assured_installments:12},headers:{Origin:origin,'X-Infinitepay-CSRF':csrf_token}});
    assert.equal(allowed.status,200);
});

test('changed products and unavailable special meals preserve structured public conflict details', async () => {
    const count = await f.db('pedidos').count('* as n').first();
    const [category] = await f.db('categorias_produtos').insert({nome:'Bebidas sintéticas'}).returning('*');
    const [product] = await f.db('produtos').insert({nome:'Água sintética',categoria_produto_id:category.id,preco:3,disponivel_hoje:true}).returning('*');
    const changed = await fetch(base+'/pedidos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        ...legacyPayload,metodo_pagamento_id:31,produtos:[{produto_id:product.id,quantidade:1,preco_referencia:2}]
    })});
    assert.equal(changed.status,409);
    const details = await changed.json();
    assert.equal(details.code,'PRODUTOS_ALTERADOS');
    assert.equal(details.details.produtos[0].preco_atual,3);
    const [meal] = await f.db('marmitas_especiais').insert({nome:'Especial sintética',preco:25,ativo:false}).returning('*');
    const unavailable = await fetch(base+'/pedidos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        ...legacyPayload,metodo_pagamento_id:31,marmitas_especiais:[{marmita_especial_id:meal.id,quantidade:1,preco_referencia:25}]
    })});
    assert.equal(unavailable.status,409);
    const special = await unavailable.json();
    assert.equal(special.code,'MARMITAS_ESPECIAIS_ALTERADAS');
    assert.equal(special.details.marmitas_especiais[0].tipo,'INDISPONIVEL');
    assert.deepEqual(await f.db('pedidos').count('* as n').first(),count);
});

let policySequence = 100;
async function pendingOnlineFixture({ deleted = false, released = false } = {}) {
    const response = await request('/pedidos', { method: 'POST', body: {
        ...legacyPayload, metodo_pagamento_id: 33, telefone_cliente: '1198888' + (++policySequence)
    } });
    assert.equal(response.status, 201);
    const id = (await response.json()).data.pedido_id;
    await f.db('pedidos').where({ id }).update({ fluxo_pagamento: 'INFINITEPAY',
        liberado_cozinha_em: released ? new Date() : null,
        ...(deleted ? { deletado_em: new Date(), status: 'Cancelado' } : {}) });
    return f.db('pedidos').where({ id }).first();
}
async function verifiedPaymentFixture(order, overrides = {}) {
    const { randomUUID } = await import('node:crypto');
    const [row] = await f.db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1,
        order_nsu: 'SYNTHETIC-' + randomUUID(), status: 'PAGA', valor_centavos: 2000,
        valor_base_provider_centavos: 2000, valor_pago_provider_centavos: 2100,
        valid_until: new Date(Date.now() + 3600000), provider_verified_at: new Date(), pago_em: new Date(),
        transaction_nsu: randomUUID(), invoice_slug: 'synthetic-invoice-' + order.id,
        capture_method: 'pix', ...overrides }).returning('*');
    return row;
}

test('unpaid online orders are absent from the operational list, pagination and complete-order lookup', async () => {
    const order = await pendingOnlineFixture();
    const response = await request('/pedidos/admin?search=' + order.telefone_cliente);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, []);
    assert.equal(body.pagination.total, 0);
    const { buscarPedidoCompletoPorId } = await import('../../src/utils/pedidosUtils.js');
    assert.equal(await buscarPedidoCompletoPorId(order.id), undefined);
    const tracking = await request('/pedidos/rastreio/' + order.telefone_cliente);
    assert.equal(tracking.status, 404);
});

for (const status of ['Pendente', 'Em Preparo', 'Saiu para Entrega', 'Entregue', 'Cancelado']) {
    test('unpaid online order rejects operational status ' + status, async () => {
        const order = await pendingOnlineFixture();
        const events = [];
        global.io = { to: () => ({ emit: (...args) => events.push(args) }) };
        try {
            const response = await request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status } });
            assert.equal(response.status, 409);
            assert.deepEqual(await f.db('pedidos').where({ id: order.id }).first(), order);
            assert.deepEqual(events, []);
        } finally { delete global.io; }
    });
}

for (const [label, verb, suffix, body, deleted] of [
    ['edit items and method', 'PATCH', '', { marmitas: [], metodo_pagamento_id: 31 }, false],
    ['delete', 'DELETE', '', undefined, false],
    ['restore', 'PATCH', '/restaurar', {}, true]
]) {
    test('online financial protection blocks ' + label + ' without changing orders or items', async () => {
        const order = await pendingOnlineFixture({ deleted });
        const payment = await verifiedPaymentFixture(order, { status: 'INCERTA', pago_em: null, provider_verified_at: null });
        const items = await f.db('itens_pedido').where({ pedido_id: order.id }).orderBy('id');
        const composition = await f.db('composicao_item_pedido').whereIn('item_pedido_id', items.map(item => item.id));
        const response = await request('/pedidos/' + order.id + suffix, { method: verb, body });
        assert.equal(response.status, 409);
        assert.deepEqual(await f.db('pedidos').where({ id: order.id }).first(), order);
        assert.deepEqual(await f.db('pagamentos').where({ id: payment.id }).first(), payment);
        assert.deepEqual(await f.db('itens_pedido').where({ pedido_id: order.id }).orderBy('id'), items);
        assert.deepEqual(await f.db('composicao_item_pedido').whereIn('item_pedido_id', items.map(item => item.id)), composition);
    });
}

test('financial protection also rejects legacy cancellation paths when a posterior order has a linked attempt', async () => {
    const online = await pendingOnlineFixture();
    await verifiedPaymentFixture(online, { status: 'AGUARDANDO', pago_em: null, provider_verified_at: null });
    await f.db('pedidos').where({ id: online.id }).update({ fluxo_pagamento: 'POSTERIOR' });
    const before = await f.db('pedidos').where({ id: online.id }).first();
    for (const [method, suffix, body] of [['DELETE', '', undefined], ['PATCH', '/status', { status: 'Cancelado' }],
        ['PATCH', '', { metodo_pagamento_id: 31 }]]) {
        assert.equal((await request('/pedidos/' + online.id + suffix, { method, body })).status, 409);
        assert.deepEqual(await f.db('pedidos').where({ id: online.id }).first(), before);
    }
});

for (const field of ['fluxo_pagamento', 'liberado_cozinha_em', 'provider_verified_at', 'pago_em', 'status_pagamento']) {
    test('client cannot write financial control field ' + field, async () => {
        const before = await f.db('pedidos').count('* as n').first();
        const response = await request('/pedidos', { method: 'POST', body: {
            ...legacyPayload, metodo_pagamento_id: 33, [field]: field === 'fluxo_pagamento' ? 'POSTERIOR' : '2026-01-01'
        } });
        assert.equal(response.status, 400);
        assert.deepEqual(await f.db('pedidos').count('* as n').first(), before);
    });
}

test('release timestamp alone and unverified paid rows do not authorize kitchen access', async () => {
    const order = await pendingOnlineFixture({ released: true });
    for (const payment of [null, { provider_verified_at: null }, { valor_base_provider_centavos: 1900 }, { transaction_nsu: null }]) {
        if (payment !== null) {
            const existing = await f.db('pagamentos').where({ pedido_id: order.id }).first();
            if (existing) await f.db('pagamentos').where({ id: existing.id }).update({
                provider_verified_at: new Date(), valor_base_provider_centavos: 2000,
                transaction_nsu: 'synthetic-transaction', ...payment });
            else await verifiedPaymentFixture(order, payment);
        }
        assert.equal((await request('/pedidos/' + order.id + '/status', {
            method: 'PATCH', body: { status: 'Em Preparo' }
        })).status, 409);
        const list = await (await request('/pedidos/admin?search=' + order.telefone_cliente)).json();
        assert.equal(list.pagination.total, 0);
    }
});

for (const field of ['transaction_nsu', 'invoice_slug']) {
    for (const [label, value] of [
        ['null', null], ['empty', ''], ['spaces', '   '],
        ['tabs', '\t\t'], ['newlines', '\r\n'], ['mixed whitespace', ' \t\r\n '],
        ['NBSP', '\u00a0'], ['EM SPACE', '\u2003'], ['BOM', '\ufeff']
    ]) {
        test('paid online order with ' + label + ' ' + field + ' remains outside operations', async () => {
            const order = await pendingOnlineFixture({ released: true });
            const payment = await verifiedPaymentFixture(order, { [field]: value });
            const events = [];
            global.io = { to: () => ({ emit: (...args) => events.push(args) }) };
            try {
                const response = await request('/pedidos/' + order.id + '/status', {
                    method: 'PATCH', body: { status: 'Em Preparo' }
                });
                assert.equal(response.status, 409);
                assert.deepEqual(await f.db('pedidos').where({ id: order.id }).first(), order);
                assert.deepEqual(await f.db('pagamentos').where({ id: payment.id }).first(), payment);
                assert.deepEqual(events, []);
                const listing = await request('/pedidos/admin?search=' + order.telefone_cliente);
                assert.equal(listing.status, 200);
                const list = await listing.json();
                assert.deepEqual(list.data, []);
                assert.equal(list.pagination.total, 0);
                const { buscarPedidoCompletoPorId } = await import('../../src/utils/pedidosUtils.js');
                assert.equal(await buscarPedidoCompletoPorId(order.id), undefined);
                assert.equal((await request('/pedidos/rastreio/' + order.telefone_cliente)).status, 404);
            } finally { delete global.io; }
        });
    }
}

test('verified release accepts opaque provider identifiers containing non-whitespace content', async () => {
    const order = await pendingOnlineFixture({ released: true });
    await verifiedPaymentFixture(order, {
        transaction_nsu: ' \tprovider/nsu:42\r\n ', invoice_slug: '\n invoice/reference:42\t '
    });
    const response = await request('/pedidos/' + order.id + '/status', {
        method: 'PATCH', body: { status: 'Em Preparo' }
    });
    assert.equal(response.status, 200);
    assert.equal((await f.db('pedidos').where({ id: order.id }).first()).status, 'Em Preparo');
    const list = await (await request('/pedidos/admin?search=' + order.telefone_cliente)).json();
    assert.equal(list.pagination.total, 1);
    assert.equal(list.data[0].id, order.id);
    const { buscarPedidoCompletoPorId } = await import('../../src/utils/pedidosUtils.js');
    assert.equal((await buscarPedidoCompletoPorId(order.id)).id, order.id);
});

test('persisted verified release permits preparation and refund does not erase prior operational release', async () => {
    const order = await pendingOnlineFixture({ released: true });
    const payment = await verifiedPaymentFixture(order);
    const response = await request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status: 'Em Preparo' } });
    assert.equal(response.status, 200);
    const list = await (await request('/pedidos/admin?search=' + order.telefone_cliente)).json();
    assert.equal(list.data[0].id, order.id);
    await f.db('pagamentos').where({ id: payment.id }).update({ status: 'ESTORNADA', estornado_em: new Date() });
    assert.equal((await request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status: 'Saiu para Entrega' } })).status, 200);
    assert.equal((await request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status: 'Cancelado' } })).status, 409);
});

test('disabled checkout preserves all public payment choices, ignores claimed origin and makes no external calls', async () => {
    const originalFetch = global.fetch;
    const financialBefore = await f.db('pagamentos').select('*').orderBy('id');
    const externalCalls = [];
    global.fetch = (input, options) => {
        if (new URL(input).origin !== base) { externalCalls.push(String(input)); throw new Error('External request forbidden in phase 2A'); }
        return originalFetch(input, options);
    };
    try {
        for (const method of [31, 32, 33, 34]) {
            const response = await request('/pedidos', { method: 'POST', body: {
                ...legacyPayload, tipo_pedido: 'Presencial', metodo_pagamento_id: method,
                origem: 'ADMIN', pedidoOrigem: 'ADMIN', origemPedido: 'ADMIN'
            } });
            assert.equal(response.status, 201);
            const row = await f.db('pedidos').where({ id: (await response.json()).data.pedido_id }).first();
            assert.equal(row.fluxo_pagamento, 'POSTERIOR');
        }
        assert.deepEqual(externalCalls, []);
        assert.deepEqual(await f.db('pagamentos').select('*').orderBy('id'), financialBefore);
    } finally { global.fetch = originalFetch; }
});

test('creation reloads persisted eligibility and never emits an unpaid online order to kitchen', async () => {
    // Synthetic trigger injects a future stored order into today's disabled creation path.
    await f.db.raw(`CREATE FUNCTION phase2a_pending_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.nome_cliente = 'SYNTHETIC_UNPAID_CREATION' THEN
            NEW.fluxo_pagamento := 'INFINITEPAY'; NEW.liberado_cozinha_em := NULL;
        END IF; RETURN NEW; END; $$`);
    await f.db.raw('CREATE TRIGGER phase2a_pending_fixture BEFORE INSERT ON pedidos FOR EACH ROW EXECUTE FUNCTION phase2a_pending_fixture()');
    const events = [];
    const paymentsBefore = await f.db('pagamentos').select('*').orderBy('id');
    global.io = { to: () => ({ emit: (...args) => events.push(args) }) };
    try {
        const response = await request('/pedidos', { method: 'POST', body: {
            ...legacyPayload, nome_cliente: 'SYNTHETIC_UNPAID_CREATION', metodo_pagamento_id: 33
        } });
        assert.equal(response.status, 201);
        const order = await f.db('pedidos').where({ id: (await response.json()).data.pedido_id }).first();
        assert.equal(order.fluxo_pagamento, 'INFINITEPAY');
        assert.equal(order.liberado_cozinha_em, null);
        assert.deepEqual(events, []);
        assert.deepEqual(await f.db('pagamentos').select('*').orderBy('id'), paymentsBefore);
    } finally {
        delete global.io;
        await f.db.raw('DROP TRIGGER phase2a_pending_fixture ON pedidos');
        await f.db.raw('DROP FUNCTION phase2a_pending_fixture()');
    }
});

test('legacy orders with null release timestamp keep listing, editing, status, soft deletion and restoration', async () => {
    const online = await pendingOnlineFixture();
    await f.db('pedidos').where({ id: online.id }).update({ fluxo_pagamento: 'POSTERIOR', criado_em: '2025-01-01T12:00:00Z' });
    const before = await f.db('pedidos').where({ id: online.id }).first();
    assert.equal(before.liberado_cozinha_em, null);
    const listing = await (await request('/pedidos/admin?search=' + before.telefone_cliente)).json();
    assert.equal(listing.data[0].id, before.id);
    assert.equal((await request('/pedidos/' + before.id, { method: 'PATCH', body: {
        observacoes: 'Alteração legada sintética', metodo_pagamento_id: 32
    } })).status, 200);
    assert.equal((await request('/pedidos/' + before.id + '/status', { method: 'PATCH', body: { status: 'Em Preparo' } })).status, 200);
    assert.equal((await request('/pedidos/' + before.id, { method: 'DELETE' })).status, 200);
    assert.equal((await request('/pedidos/' + before.id + '/restaurar', { method: 'PATCH', body: {} })).status, 200);
    const after = await f.db('pedidos').where({ id: before.id }).first();
    assert.equal(after.status, 'Pendente');
    assert.equal(after.fluxo_pagamento, 'POSTERIOR');
    assert.equal(after.liberado_cozinha_em, null);
    assert.equal(after.deletado_em, null);
    assert.equal(after.valor_total, before.valor_total);
    assert.equal(after.criado_em.toISOString(), before.criado_em.toISOString());
    assert.equal(await f.db('pagamentos').where({ pedido_id: before.id }).count('* as n').first().then(r => Number(r.n)), 0);
});

test('financial input is rejected on every administrative mutation without changing a legacy order', async () => {
    const online = await pendingOnlineFixture();
    await f.db('pedidos').where({ id: online.id }).update({ fluxo_pagamento: 'POSTERIOR' });
    const before = await f.db('pedidos').where({ id: online.id }).first();
    for (const [method, suffix] of [['PATCH', ''], ['PATCH', '/status'], ['DELETE', ''], ['PATCH', '/restaurar']]) {
        const response = await request('/pedidos/' + before.id + suffix, { method, body: {
            fluxo_pagamento: 'POSTERIOR', liberado_cozinha_em: new Date().toISOString(), status: 'Em Preparo'
        } });
        assert.equal(response.status, 400);
        assert.deepEqual(await f.db('pedidos').where({ id: before.id }).first(), before);
    }
});

test('an enabled environment flag with inactive database configuration preserves public and assisted creation', async () => {
    process.env.INFINITEPAY_CHECKOUT_ENABLED = 'true';
    try {
        assert.equal((await f.db('config_infinitepay').where({ id: 1 }).first()).ativo, false);
        for (const path of ['/pedidos', '/pedidos/admin']) {
            const response = await request(path, { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33 } });
            assert.equal(response.status, 201);
            assert.equal((await f.db('pedidos').where({ id: (await response.json()).data.pedido_id }).first()).fluxo_pagamento, 'POSTERIOR');
        }
    } finally { process.env.INFINITEPAY_CHECKOUT_ENABLED = 'false'; }
});

test('operational status waits for the order lock and rechecks eligibility after a concurrent change', async () => {
    const order = await pendingOnlineFixture({ released: true });
    await verifiedPaymentFixture(order);
    const writer = await f.db.transaction();
    let responsePromise;
    try {
        await writer('pedidos').where({ id: order.id }).forUpdate().first();
        const pid = (await writer.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        responsePromise = request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status: 'Em Preparo' } });
        const { setTimeout: pause } = await import('node:timers/promises');
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
            blocked = (await f.db.raw('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
            if (blocked) break;
            await pause(10);
        }
        assert.equal(blocked, true, 'the competing HTTP mutation must wait for the writer, not use a stale snapshot');
        await writer('pedidos').where({ id: order.id }).update({ liberado_cozinha_em: null });
        await writer.commit();
        assert.equal((await responsePromise).status, 409);
        const after = await f.db('pedidos').where({ id: order.id }).first();
        assert.equal(after.status, 'Pendente');
        assert.equal(after.liberado_cozinha_em, null);
    } finally {
        if (!writer.isCompleted()) await writer.rollback();
        if (responsePromise) await responsePromise;
    }
});

test('Phase 2D app mounts financial routes closed by default without exposing query secrets', async () => {
    const response = await request('/pagamentos/consulta?ref=PRIVATE_QUERY_MUST_NOT_LEAK');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const error = await f.db('logs').where({ acao: 'SISTEMA.ERRO', endpoint: '/pagamentos' }).orderBy('id', 'desc').first();
    assert.ok(error); assert.equal(JSON.stringify(error).includes('PRIVATE_QUERY_MUST_NOT_LEAK'), false);
});

async function withOperationalFixture(action, { uncertain = false, enabled = true, checkoutUrl = 'https://checkout.invalid.test/only-mocked' } = {}) {
    const app = (await import('../../src/app.js')).default;
    const { createInfinitepayRuntime } = await import('../../src/infinitepayRuntime.js');
    const { encryptApiKey } = await import('../../src/utils/infinitepayCredentials.js');
    const previousKey = process.env.INFINITEPAY_ENCRYPTION_KEY;
    const config = await f.db('config_infinitepay').where({ id: 1 }).first();
    const sent = [], sockets = [], previousIo = global.io;
    process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const [credential] = await f.db('infinitepay_credenciais').insert({ handle: 'synthetic-2d-app', ...encryptApiKey('SYNTHETIC_2D_APP_KEY', 'synthetic-2d-app') }).returning('*');
    await f.db('config_infinitepay').where({ id: 1 }).update({ handle: credential.handle, credencial_atual_id: credential.id });
    global.io = { to: () => ({ emit: (...args) => sockets.push(args) }) };
    const runtime = createInfinitepayRuntime({ db: f.db, creationEnabled: async () => enabled,
        checkoutClient: { async createCheckout(input) {
            sent.push(input);
            const payment = await f.db('pagamentos').where({ order_nsu: input.payload.order_nsu }).first();
            assert.ok(payment, 'order, items and attempt must commit before transport');
            await f.db.transaction(async trx => { await trx('pedidos').where({ id: payment.pedido_id }).forUpdate().noWait().first(); });
            if (uncertain) throw new Error('SYNTHETIC_2D_APP_KEY transport failure');
            return { checkoutUrl, invoiceSlug: 'slug-' + payment.id };
        } }, checkClient: { async checkPayment() { return { paid: false }; } }, parseEvent: raw => raw,
        deliver: async () => {}, redirectUrl: 'https://backend.invalid.test/pagamentos/infinitepay/retorno',
        webhookUrl: 'https://backend.invalid.test/pagamentos/infinitepay/webhook', successUrl: 'https://shop.invalid.test/pedido/sucesso' });
    app.locals.infinitepayRuntime = runtime;
    try { await action({ app, runtime, sent, sockets, credential }); }
    finally {
        delete app.locals.infinitepayRuntime; global.io = previousIo;
        process.env.INFINITEPAY_ENCRYPTION_KEY = previousKey;
        await f.db('config_infinitepay').where({ id: 1 }).update({ handle: config.handle, credencial_atual_id: config.credencial_atual_id });
    }
}

test('online public creation atomically reserves server prices and capabilities; parallel UUID submissions cannot duplicate orders', async () => {
    await withOperationalFixture(async ({ runtime, sent, sockets }) => {
        const { randomUUID } = await import('node:crypto');
        const client_request_id = randomUUID();
        const ordersBefore = Number((await f.db('pedidos').count('* as n').first()).n);
        const body = { ...legacyPayload, metodo_pagamento_id: 33, tipo_pedido: 'Presencial', client_request_id, valor_total: 0.01 };
        const responses = await Promise.all(Array.from({ length: 6 }, () => request('/pedidos?access_token=QUERY_SENTINEL_2D', { method: 'POST', body })));
        assert.deepEqual(responses.map(r => r.status).sort(), [201,409,409,409,409,409]);
        const created = (await responses.find(r => r.status === 201).json()).data;
        assert.equal(created.fluxo_pagamento, 'INFINITEPAY'); assert.equal(created.pagamento_status, 'AGUARDANDO');
        assert.match(created.access_token, /^[A-Za-z0-9_-]{43}$/); assert.match(created.status_ref, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(sent.length, 1); assert.equal(sent[0].payload.items[0].price, 2000);
        assert.equal(Number((await f.db('pedidos').count('* as n').first()).n) - ordersBefore, 1);
        const order = await f.db('pedidos').where({ id: created.pedido_id }).first();
        assert.equal(order.client_request_id, client_request_id); assert.equal(order.liberado_cozinha_em, null);
        assert.equal(Number((await f.db('itens_pedido').where({ pedido_id: order.id }).count('* as n').first()).n), 1);
        assert.equal(sockets.length, 0);
        assert.equal((await request('/pedidos/' + order.id + '/status', { method: 'PATCH', body: { status: 'Em Preparo' } })).status, 409);
        const resume = await fetch(base + '/pagamentos/retomar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + created.access_token }, body: JSON.stringify({ client_request_id }) });
        assert.equal(resume.status, 200); assert.equal(sent.length, 1);
        const action = await f.db('logs').where({ acao: 'PEDIDO.CRIAR' }).orderBy('id', 'desc').first();
        assert.equal(action.endpoint, '/pedidos/');
        const serialized = JSON.stringify({ action, payload: sent[0].payload });
        for (const secret of [created.access_token, created.status_ref, 'QUERY_SENTINEL_2D', 'SYNTHETIC_2D_APP_KEY']) assert.equal(serialized.includes(secret), false);
        assert.equal((await runtime.status(order.id)).cozinha_liberada, false);
    });
});

test('online creation rejects missing UUID and non-JSON without creating orders or attempts', async () => {
    await withOperationalFixture(async ({ sent }) => {
        const before = await f.db('pedidos').select('*');
        for (const client_request_id of [undefined, null, '', '   ']) assert.equal((await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33, client_request_id } })).status, 400);
        assert.equal((await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33 }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
        assert.deepEqual(await f.db('pedidos').select('*'), before); assert.equal(sent.length, 0);
    });
});

test('failure during reservation rolls back order, items and access before any simulated provider call', async () => {
    await withOperationalFixture(async ({ sent, credential }) => {
        const { randomUUID } = await import('node:crypto');
        const counts = async () => Promise.all(['pedidos', 'itens_pedido', 'pagamentos', 'pedido_acessos'].map(async table => Number((await f.db(table).count('* as n').first()).n)));
        const before = await counts();
        await f.db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: null });
        try { assert.equal((await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33, client_request_id: randomUUID() } })).status, 503); }
        finally { await f.db('config_infinitepay').where({ id: 1 }).update({ credencial_atual_id: credential.id }); }
        assert.deepEqual(await counts(), before); assert.equal(sent.length, 0);
    });
});

test('uncertain online creation preserves holder recovery and blocks kitchen, while cash, debit and admin keep legacy creation', async () => {
    await withOperationalFixture(async ({ sent, sockets }) => {
        const { randomUUID } = await import('node:crypto'); const client_request_id = randomUUID();
        const response = await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 34, client_request_id } });
        assert.equal(response.status, 201);
        const online = (await response.json()).data; assert.equal(online.pagamento_status, 'INCERTA'); assert.equal(online.checkout_url, undefined);
        assert.match(online.access_token, /^[A-Za-z0-9_-]{43}$/); assert.equal(sockets.length, 0);
        for (const [path, methodId] of [['/pedidos',31], ['/pedidos',32], ['/pedidos/admin',33], ['/pedidos/admin',34]]) {
            const legacy = await request(path, { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: methodId } });
            assert.equal(legacy.status, 201); const data = (await legacy.json()).data;
            assert.equal(data.access_token, undefined); assert.equal((await f.db('pedidos').where({ id: data.pedido_id }).first()).fluxo_pagamento, 'POSTERIOR');
        }
        assert.equal(sent.length, 1); assert.equal(sockets.length, 4);
    }, { uncertain: true });
});

test('a changed creation gate is rechecked inside the order transaction and fails closed', async () => {
    await withOperationalFixture(async ({ runtime, sent, sockets }) => {
        const original = runtime.checkoutEnabled; let checks = 0;
        runtime.checkoutEnabled = async trx => ++checks === 1 ? original(trx) : false;
        const { randomUUID } = await import('node:crypto'); const client_request_id = randomUUID();
        const response = await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33, client_request_id } });
        assert.equal(response.status, 503); assert.ok(checks >= 2);
        assert.equal(await f.db('pedidos').where({ client_request_id }).first(), undefined);
        assert.equal(sent.length, 0); assert.equal(sockets.length, 0);
    });
});

test('cash and debit remain posterior if checkout is disabled during their creation', async () => {
    await withOperationalFixture(async ({ runtime, sent, sockets }) => {
        for (const methodId of [31, 32]) {
            let checks = 0; runtime.checkoutEnabled = async () => ++checks === 1;
            const response = await request('/pedidos', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: methodId } });
            assert.equal(response.status, 201);
            const created = (await response.json()).data;
            assert.equal((await f.db('pedidos').where({ id: created.pedido_id }).first()).fluxo_pagamento, 'POSTERIOR');
        }
        assert.equal(sent.length, 0); assert.equal(sockets.length, 2);
    });
});

test('a reserved online UUID cannot fall back to a new posterior order after disabling or removing the runtime', async () => {
    await withOperationalFixture(async ({ runtime, app, sent, sockets }) => {
        const { randomUUID } = await import('node:crypto'); const client_request_id = randomUUID();
        const payload = { ...legacyPayload, metodo_pagamento_id: 33, client_request_id };
        assert.equal((await request('/pedidos', { method: 'POST', body: payload })).status, 201);
        const orders = await f.db('pedidos').select('*'), items = await f.db('itens_pedido').select('*');
        runtime.checkoutEnabled = async () => false;
        for (const methodId of [33, 31, 32]) assert.equal((await request('/pedidos', { method: 'POST', body: { ...payload, metodo_pagamento_id: methodId } })).status, 409);
        delete app.locals.infinitepayRuntime;
        assert.equal((await request('/pedidos', { method: 'POST', body: payload })).status, 409);
        assert.deepEqual(await f.db('pedidos').select('*'), orders); assert.deepEqual(await f.db('itens_pedido').select('*'), items);
        assert.equal(sent.length, 1); assert.equal(sockets.length, 0);
    });
});

async function browserSession() {
    const response = await fetch(base + '/pagamentos/sessao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); return (await response.json()).data;
}
async function browserRequest(session, path, { method = 'GET', body, headers = {} } = {}) {
    return fetch(base + '/pagamentos/sessao' + path, { method, headers: { Authorization: 'Bearer ' + session.session_token,
        'X-Checkout-CSRF': session.csrf_token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
}
for (const [methodId, code, type] of [[31,'DINHEIRO','DINHEIRO'],[32,'CARTAO_DEBITO','DEBITO'],[33,'PIX','PIX'],[34,'CARTAO_CREDITO','CREDITO']]) {
    test('session journey preserves server prices and idempotency for ' + type, async () => {
        await f.db('metodos_pagamento').where({ id: methodId }).update({ codigo: code, tipo_financeiro: type });
        await withOperationalFixture(async ({ sent, sockets }) => {
            const session = await browserSession();
            const payload = { ...legacyPayload, metodo_pagamento_id: methodId, client_request_id: session.client_request_id, valor_total: 0.01 };
            const responses = await Promise.all(Array.from({ length: 4 }, () => browserRequest(session, '/pedido', { method: 'POST', body: payload })));
            assert.ok(responses.every(response => [200,201].includes(response.status)));
            const current = (await (await browserRequest(session, '/pedido')).json()).data;
            assert.equal(current.total, 20); assert.equal(current.client_request_id, session.client_request_id);
            const online = ['PIX','CREDITO'].includes(type);
            assert.equal(current.fluxo_pagamento, online ? 'INFINITEPAY' : 'POSTERIOR');
            assert.equal(current.cozinha_liberada, !online); assert.equal(sent.length, online ? 1 : 0);
            assert.equal(sockets.length, online ? 0 : 1);
            if (online) assert.equal(current.checkout_url, 'https://checkout.infinitepay.io/SYNTHETIC');
            assert.doesNotMatch(JSON.stringify(current), /access_token|token_hash|transaction_nsu|receipt_url|SYNTHETIC_2D_APP_KEY/);
            const stranger = await browserSession();
            assert.equal((await browserRequest(stranger, '/pedido?requisicao=' + session.client_request_id)).status, 404);
            assert.equal((await browserRequest(session, '/pedido', { method: 'POST', body: { ...payload, nome_cliente: 'OTHER' } })).status, 409);
            if (online) assert.equal((await browserRequest(session, '/nova-compra', { method: 'POST', body: {} })).status, 409);
        }, { checkoutUrl: 'https://checkout.infinitepay.io/SYNTHETIC' });
    });
}
test('session writes enforce JSON and session-bound CSRF without exposing tokens to logs', async () => {
    const session = await browserSession(), payload = { ...legacyPayload, metodo_pagamento_id: 31, client_request_id: session.client_request_id };
    assert.equal((await browserRequest(session, '/pedido', { method: 'POST', body: payload, headers: { 'X-Checkout-CSRF': '' } })).status, 403);
    assert.equal((await browserRequest(session, '/pedido', { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await browserRequest(session, '/pedido', { method: 'POST', body: { ...payload, fluxo_pagamento: 'POSTERIOR' } })).status, 400);
    const logs = JSON.stringify(await f.db('logs').select('payload'));
    assert.equal(logs.includes(session.session_token), false); assert.equal(logs.includes(session.csrf_token), false);
});
test('uncertain session recovers after a lost response and cannot create another attempt', async () => {
    await withOperationalFixture(async ({ sent }) => {
        const session = await browserSession();
        await browserRequest(session, '/pedido', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33, client_request_id: session.client_request_id } });
        for (let i = 0; i < 2; i++) {
            const result = await browserRequest(session, '/retomar', { method: 'POST', body: { client_request_id: session.client_request_id } });
            assert.equal(result.status, 200); assert.equal((await result.json()).data.pagamento_status, 'INCERTA');
        }
        assert.equal(sent.length, 1);
    }, { uncertain: true });
});
test('financial administration is separate from kitchen and printing authorization is checked by the backend', async () => {
    const order = await pendingOnlineFixture();
    const admin = await request('/pagamentos/admin'); assert.equal(admin.status, 200);
    assert.ok((await admin.json()).data.some(row => row.pedido_id === order.id && row.cozinha_autorizada === false));
    const operational = await request('/pedidos/admin?limit=100');
    assert.equal((await operational.json()).data.some(row => row.id === order.id), false);
    assert.equal((await request('/pedidos/' + order.id + '/operacao')).status, 409);
    assert.equal((await fetch(base + '/pagamentos/admin')).status, 401);
});
test('a correlated STATUS return keeps its order and only an owning session can read its receipt', async () => {
    await f.db('metodos_pagamento').where({ id: 33 }).update({ codigo: 'PIX', tipo_financeiro: 'PIX' });
    await withOperationalFixture(async ({ app, runtime }) => {
        const { createCheckoutSessionService } = await import('../../src/services/checkoutSessionService.js');
        const owner = await browserSession();
        const response = await browserRequest(owner, '/pedido', { method: 'POST', body: { ...legacyPayload, metodo_pagamento_id: 33, client_request_id: owner.client_request_id } });
        const order = (await response.json()).data;
        const access = await f.db.transaction(trx => runtime.issueAccess(trx, order.pedido_id));
        const sessions = createCheckoutSessionService({ db: f.db, runtime: () => app.locals.infinitepayRuntime });
        const own = await sessions.lookupStatus(owner.session_token, access.status_ref);
        assert.equal(own.pedido_id, order.pedido_id);
        const stranger = await browserSession();
        const limited = await sessions.lookupStatus(stranger.session_token, access.status_ref);
        assert.equal(limited.pedido_id, undefined); assert.equal(limited.receipt_url, undefined);
        assert.equal(limited.cozinha_liberada, false);
        await f.db('pagamentos').where({ pedido_id: order.pedido_id }).update({ status: 'PAGA', transaction_nsu: 'SYNTHETIC-RETURN-TX',
            valor_base_provider_centavos: 2000, valor_pago_provider_centavos: 2000, capture_method: 'pix', installments: 1,
            provider_verified_at: new Date(), pago_em: new Date(), receipt_url: 'https://recibo.infinitepay.io/SYNTHETIC-RETURN-TX' });
        await f.db('pedidos').where({ id: order.pedido_id }).update({ liberado_cozinha_em: new Date() });
        await sessions.newRequest(owner.session_token);
        assert.equal((await sessions.lookup(owner.session_token)).pedido_id, null);
        const previous = await sessions.lookupStatus(owner.session_token, access.status_ref);
        assert.equal(previous.pedido_id, order.pedido_id); assert.ok(previous.receipt_url);
        assert.equal((await sessions.lookupStatus(stranger.session_token, access.status_ref)).receipt_url, undefined);
    });
});
test('admin receipt requires permission, independent verification and exact transaction-bound HTTPS', async () => {
    const order = await pendingOnlineFixture({ released: true });
    const payment = await verifiedPaymentFixture(order);
    assert.equal((await request('/pagamentos/admin/' + order.id + '/comprovante')).status, 404);
    await f.db('pagamentos').where({ id: payment.id }).update({ receipt_url: 'https://recibo.infinitepay.io/' + payment.transaction_nsu });
    const receipt = await request('/pagamentos/admin/' + order.id + '/comprovante'); assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).data.receipt_url, 'https://recibo.infinitepay.io/' + payment.transaction_nsu);
    assert.equal((await request('/pagamentos/admin/' + order.id + '/comprovante', { id: 3 })).status, 403);
    await f.db('pagamentos').where({ id: payment.id }).update({ receipt_url: 'https://recibo.infinitepay.io/OTHER' });
    assert.equal((await request('/pagamentos/admin/' + order.id + '/comprovante')).status, 404);
});
test('printing authorization rejects inactive users and stale admin roles', async () => {
    const order = await pendingOnlineFixture({ released: true }); await verifiedPaymentFixture(order);
    assert.equal((await request('/pedidos/' + order.id + '/operacao', { id: 4 })).status, 401);
    assert.equal((await request('/pedidos/' + order.id + '/operacao', { id: 3 })).status, 403);
});

test('operational listing exposes only a receipt availability boolean and rechecks changed proof on access', async () => {
    const order = await pendingOnlineFixture({ released: true });
    const payment = await verifiedPaymentFixture(order);
    const listing = async () => (await (await request('/pedidos/admin?search=' + order.id)).json()).data.find(row => row.id === order.id);
    assert.equal((await listing()).comprovante_disponivel, false);
    await f.db('pagamentos').where({ id: payment.id }).update({ receipt_url: 'https://recibo.infinitepay.io/' + payment.transaction_nsu });
    const available = await listing();
    assert.equal(available.comprovante_disponivel, true);
    assert.doesNotMatch(JSON.stringify(available), /receipt_url|transaction_nsu|https:\/\/recibo/);
    await f.db('pagamentos').where({ id: payment.id }).update({ receipt_url: 'https://attacker.invalid/' + payment.transaction_nsu });
    assert.equal((await listing()).comprovante_disponivel, false);
    assert.equal((await request('/pagamentos/admin/' + order.id + '/comprovante')).status, 404);
});

test('dashboard reuses financial proof, preserves operational counts and limits special meals to four', async () => {
    for (let n = 0; n < 8; n++) {
        const [special] = await f.db('marmitas_especiais').insert({ nome: 'Dashboard sintético ' + n, preco: 20 }).returning('*');
        const [order] = await f.db('pedidos').insert({ nome_cliente: 'Dashboard sintético', telefone_cliente: '11999999999',
            tipo_pedido: 'Presencial', metodo_pagamento_id: 33, valor_total: 20, fluxo_pagamento: n < 6 ? 'POSTERIOR' : 'INFINITEPAY',
            criado_em: '2050-10-25T15:00:00Z' }).returning('*');
        await f.db('itens_pedido').insert({ pedido_id: order.id, marmita_especial_id: special.id, nome_item_snapshot: special.nome,
            quantidade: 1, preco_unitario: 20, subtotal: 20 });
        if (n >= 6) await f.db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1, order_nsu: 'dashboard-' + n,
            status: n === 6 ? 'INCERTA' : 'PAGA', valor_centavos: 2000, valid_until: '2050-10-26T00:00:00Z',
            ...(n === 7 ? { provider_verified_at: '2050-10-26T01:00:00Z', pago_em: '2050-10-26T01:00:00Z',
                transaction_nsu: 'dashboard-synthetic-txn', invoice_slug: 'dashboard-synthetic-slug', capture_method: 'pix',
                valor_base_provider_centavos: 2000, valor_pago_provider_centavos: 2000 } : {}) });
    }
    const response = await request('/dashboard?data_inicio=2050-10-25&data_fim=2050-10-25');
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.cards.faturamento, 140); assert.equal(data.cards.quantidade_pedidos, 8);
    assert.equal(data.graficos.marmitas_especiais.length, 4);
    assert.equal(data.financeiro.confirmados, 1); assert.equal(data.financeiro.valor_confirmado, 20);
    assert.equal(data.financeiro.pendentes_verificacao, 1); assert.equal(data.financeiro.valor_liquido, null);
    assert.equal(data.financeiro.timezone, 'America/Sao_Paulo');
    assert.equal(data.graficos.serie_diaria[0].faturamento, 140);
    assert.equal((await request('/dashboard?data_inicio=2050-02-30')).status, 400);
});

test('financial reports preserve permissions and return explicit definitions without private provider identifiers', async () => {
    assert.equal((await request('/relatorios', { id: 3 })).status, 403);
    const catalog = await (await request('/relatorios')).json();
    const paymentReport = catalog.data.find(r => r.funcao_db === 'fn_rel_pagamentos_infinitepay');
    assert.ok(paymentReport);
    assert.equal((await request('/relatorios/' + paymentReport.id + '/gerar', { id: 3, method: 'POST', body: {} })).status, 403);
    const response = await request('/relatorios/' + paymentReport.id + '/gerar', { method: 'POST', body: { data_inicio: '2050-10-25', data_fim: '2050-10-25', criterio_temporal: 'confirmacao' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.dados.length, 1);
    assert.match(result.data.notas, /America\/Sao_Paulo/);
    assert.match(result.data.notas, /LIQUIDADA/);
    assert.ok(!JSON.stringify(result).includes('dashboard-synthetic-txn'));
});

test('normal administrative activation validates environment, credential, mappings and worker with RBAC/CSRF', async () => {
    const app=(await import('../../src/app.js')).default;
    const oldRuntime=app.locals.infinitepayRuntime;
    const {initializeInfinitepayApplication}=await import('../../src/infinitepayApplication.js');
    const {encryptApiKey}=await import('../../src/utils/infinitepayCredentials.js');
    const [credential]=await f.db('infinitepay_credenciais').insert({handle:'activation-synthetic',...encryptApiKey('SYNTHETIC_ACTIVATION_KEY','activation-synthetic')}).returning('*');
    await f.db('metodos_pagamento').where({id:33}).update({codigo:'PIX',tipo_financeiro:'PIX'});
    await f.db('metodos_pagamento').where({id:34}).update({codigo:'CARTAO_CREDITO',tipo_financeiro:'CREDITO'});
    await f.db('dados_empresa').update({imprimir_automaticamente:false});
    await f.db('config_infinitepay').where({id:1}).update({ativo:false,handle:credential.handle,credencial_atual_id:credential.id});
    const settings={NODE_ENV:'development',INFINITEPAY_MODE:'homologation',DB_HOST:'127.0.0.1',DB_NAME:'infinitepay_phase1_test',
        INFINITEPAY_DATABASE_NAME:'infinitepay_phase1_test',INFINITEPAY_CHECKOUT_ENABLED:'true',INFINITEPAY_PUBLIC_ORIGIN:'https://backend.invalid.test',
        INFINITEPAY_SUCCESS_URL:'https://shop.invalid.test/pedido/sucesso',ALLOWED_ORIGINS:'https://shop.invalid.test',
        INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'https://backend.invalid.test,https://shop.invalid.test'};
    const service=await initializeInfinitepayApplication({app,db:f.db,env:settings,transport:async()=>{throw new Error('No provider requests allowed');}});
    try {
        assert.equal((await write({ativo:true})).status,400,'worker must be running');
        service.start({intervalMs:60000});
        assert.equal((await (await request()).json()).activation_available,true);
        assert.equal((await write({ativo:true},{id:3})).status,403);
        assert.equal((await request(undefined,{method:'PUT',body:{ativo:true}})).status,403);
        const activated=await write({ativo:true}); assert.equal(activated.status,200); assert.equal((await activated.json()).data.ativo,true);
        assert.equal((await write({remove_api_key:true})).status,400);
        assert.equal((await write({ativo:false})).status,200);
        settings.INFINITEPAY_CHECKOUT_ENABLED='false';
        assert.equal((await write({ativo:true})).status,400);
        assert.equal((await f.db('config_infinitepay').first()).ativo,false);
    } finally {await service.stop();app.locals.infinitepayRuntime=oldRuntime;delete app.locals.infinitepayActivation;}
});
