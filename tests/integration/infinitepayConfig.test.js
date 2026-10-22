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
        assert.equal(errorLogs.length,2);
        assert.equal(errorLogs.every(row=>row.endpoint==='/configuracoes/infinitepay/'),true);
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
