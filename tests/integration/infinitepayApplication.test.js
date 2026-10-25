import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
describe('normal isolated application composition', { concurrency: false }, () => {
let fixture, db, service, initialize, validate, calls = 0, checks = 0, available = true, credential, size;
const clock = () => new Date('2026-10-25T15:00:00Z');
const env = { NODE_ENV: 'development', INFINITEPAY_MODE: 'homologation', INFINITEPAY_DATABASE_NAME: 'infinitepay_phase1_test',
    DB_HOST: '127.0.0.1', DB_NAME: 'infinitepay_phase1_test', INFINITEPAY_CHECKOUT_ENABLED: 'true',
    INFINITEPAY_PUBLIC_ORIGIN: 'https://backend.invalid.test', INFINITEPAY_SUCCESS_URL: 'https://shop.invalid.test/pedido/sucesso',
    INFINITEPAY_ALLOWED_PUBLIC_ORIGINS: 'https://backend.invalid.test,https://shop.invalid.test', ALLOWED_ORIGINS: 'https://shop.invalid.test' };
const previous = {};
before(async () => {
    for (const key of ['INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_CHECKOUT_ENABLED']) previous[key] = process.env[key];
    process.env.INFINITEPAY_ENCRYPTION_KEY = randomBytes(32).toString('base64'); process.env.INFINITEPAY_CHECKOUT_ENABLED = 'true';
    fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
    await db('metodos_pagamento').insert([{ id: 91, nome: 'Pix sintético', codigo: 'PIX', tipo_financeiro: 'PIX' }, { id: 92, nome: 'Crédito sintético', codigo: 'CARTAO_CREDITO', tipo_financeiro: 'CREDITO' }]);
    [size] = await db('tamanhos_marmitas').insert({ nome: 'Sintético', preco_base: 20 }).returning('*');
    [credential] = await db('infinitepay_credenciais').insert({ handle: 'synthetic-account', ...encryptApiKey('SYNTHETIC_APPLICATION_KEY', 'synthetic-account') }).returning('*');
    await db('config_infinitepay').where({ id: 1 }).update({ handle: credential.handle, credencial_atual_id: credential.id });
    ({ initializeInfinitepayApplication: initialize, validateInfinitepayEnvironment: validate } = await import('../../src/infinitepayApplication.js'));
});
after(async () => { await service?.stop(); await fixture?.close(); for (const [key,value] of Object.entries(previous)) { if(value === undefined) delete process.env[key]; else process.env[key] = value; } });
async function transport(url, options) {
    assert.equal(options.headers['X-Api-Key'], 'SYNTHETIC_APPLICATION_KEY'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    if (url.endsWith('/links')) { calls++; assert.equal(body.handle, undefined); return { status: 200, json: async () => ({ url: 'https://checkout.infinitepay.io/SYNTHETIC-' + calls }) }; }
    assert.ok(url.endsWith('/payment_check')); checks++; if (!available) throw new Error('SYNTHETIC_APPLICATION_KEY');
    return { status: 200, json: async () => ({ success: true, paid: true, amount: 2000, paid_amount: 2100, installments: 1, capture_method: 'credit_card' }) };
}
async function reserve(id) {
    await db('pedidos').insert({ id, nome_cliente: 'SINTETICO', telefone_cliente: '11999999999', tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: 91, fluxo_pagamento: 'INFINITEPAY', valor_total: 20 });
    await db('itens_pedido').insert({ pedido_id: id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: 20, subtotal: 20 });
    return db.transaction(trx => service.runtime.reserveCreation(trx,id,`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`));
}
test('normal composition is disabled by default and refuses production/test activation or undeclared HTTPS/database', async () => {
    assert.equal(validate({}), null);
    for (const extra of [{ NODE_ENV:'production' }, { NODE_ENV:'test' }, { DB_HOST:'production.invalid' }, { DB_NAME:'production' },
        { INFINITEPAY_DATABASE_NAME:'infinitepay_h1_homologacao' }, { INFINITEPAY_PUBLIC_ORIGIN:'http://backend.invalid.test' },
        { INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'' }, { ALLOWED_ORIGINS:'https://other.invalid.test' }]) assert.throws(() => validate({ ...env,...extra }), /homologação/);
    assert.throws(() => validate({ INFINITEPAY_CHECKOUT_ENABLED:'true' }), /homologação/);
});
test('startup prepares existing real clients without dispatching and requires explicit administrative activation', async () => {
    const app = { locals: {} }; service = await initialize({ app, db, env, transport, now: clock });
    assert.equal(calls,0); assert.equal(checks,0); assert.equal((await db('config_infinitepay').first()).ativo,false);
    assert.equal(await service.runtime.checkoutEnabled(),false);
    service.start({ intervalMs: 20 });
    await service.assertReady(db,await db('config_infinitepay').first());
    await db('config_infinitepay').where({ id:1 }).update({ ativo:true });
    assert.equal(await service.runtime.checkoutEnabled(),true);
    assert.equal(app.locals.infinitepayRuntime,service.runtime);
});
test('observed url contract creates once and unsupported event/response cannot fabricate financial settlement', async () => {
    const reservation = await reserve(501); const result = await service.runtime.finishCreation(reservation);
    assert.equal(result.pagamento_status,'AGUARDANDO'); assert.ok(result.checkout_url);
    const same = await db.transaction(trx=>service.runtime.reserveCreation(trx,501,'00000000-0000-4000-8000-000000000501'));
    await service.runtime.finishCreation(same); assert.equal(calls,1);
    await assert.rejects(service.runtime.receiveEvent({ event_type:'refunded', order_nsu:reservation.attempt.order_nsu, invoice_slug:'synthetic' }));
});
test('emergency disable preserves verification and durable isolated delivery without kitchen or new charge', async () => {
    await service.stop();
    const payment = await db('pagamentos').where({ pedido_id:501 }).first();
    available=false; await db('config_infinitepay').where({ id:1 }).update({ ativo:false });
    assert.equal(await service.runtime.checkoutEnabled(),false);
    const event = { event_type:'paid',order_nsu:payment.order_nsu,invoice_slug:'SYNTHETIC-SLUG',transaction_nsu:'SYNTHETIC-TXN',receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TXN' };
    await service.runtime.receiveEvent(event); await service.runtime.processPending();
    assert.notEqual((await db('pagamentos').where({ id:payment.id }).first()).status,'PAGA');
    available=true;
    await db('pagamentos_eventos').where({ pagamento_id:payment.id }).update({ proxima_tentativa_em:null });
    await service.runtime.processPending();
    assert.equal((await db('pagamentos').where({ id:payment.id }).first()).status,'PAGA');
    assert.equal((await db('pagamentos').where({ id:payment.id }).first()).receipt_url,event.receipt_url);
    assert.equal(Number((await db('infinitepay_entregas_homologacao').count('* as n').first()).n),1);
    for(let i=0;i<3;i++) await service.runtime.receiveEvent(event);
    await service.runtime.processPending(); assert.equal(calls,1);
    assert.equal(Number((await db('outbox_eventos').where({ pedido_id:501 }).count('* as n').first()).n),1);
    assert.equal(Number((await db('infinitepay_entregas_homologacao').count('* as n').first()).n),1);
    assert.equal(service.status().consumer,'isolated');
});
test('disabling after durable reservation but before dispatch prevents even the first provider call', async () => {
    service.start({intervalMs:60000}); await db('config_infinitepay').where({id:1}).update({ativo:true});
    const reservation=await reserve(502); await db('config_infinitepay').where({id:1}).update({ativo:false});
    assert.equal((await service.runtime.finishCreation(reservation)).pagamento_status,'FALHOU');
    assert.equal(calls,1); assert.equal((await db('pagamentos').where({pedido_id:502}).first()).bloqueia_nova_cobranca,true);
});
test('shutdown during an asynchronous preflight prevents a subsequent provider dispatch', async () => {
    const {createInfinitepayRuntime}=await import('../../src/infinitepayRuntime.js');
    await db('config_infinitepay').where({id:1}).update({ativo:true});
    const reservation=await reserve(503);
    let enter, release, running=true, sent=0;
    const entered=new Promise(resolve=>{enter=resolve;}); const barrier=new Promise(resolve=>{release=resolve;});
    const runtime=createInfinitepayRuntime({db,environment:env,activationCheck:async()=>{enter();await barrier;return true;},
        dispatchStateAllowed:()=>running,checkoutClient:{async createCheckout(){sent++;return {checkoutUrl:'https://checkout.infinitepay.io/SYNTHETIC-RACE'};}},
        checkClient:{async checkPayment(){return {paid:false};}},parseEvent:()=>({}),deliver:async()=>{},
        redirectUrl:env.INFINITEPAY_PUBLIC_ORIGIN+'/pagamentos/infinitepay/retorno',webhookUrl:env.INFINITEPAY_PUBLIC_ORIGIN+'/pagamentos/infinitepay/webhook',successUrl:env.INFINITEPAY_SUCCESS_URL});
    const result=runtime.finishCreation(reservation);await entered;running=false;release();
    assert.equal((await result).pagamento_status,'FALHOU');assert.equal(sent,0);
    await db('config_infinitepay').where({id:1}).update({ativo:false});
});
test('administrative deactivation cannot acknowledge before a dispatch already in preflight is resolved', async () => {
    const {createInfinitepayRuntime}=await import('../../src/infinitepayRuntime.js');
    await db('config_infinitepay').where({id:1}).update({ativo:true});
    const reservation=await reserve(504);
    let enter, release, acknowledged=false, sentAfterAcknowledgement=false;
    const entered=new Promise(resolve=>{enter=resolve;}); const barrier=new Promise(resolve=>{release=resolve;});
    const runtime=createInfinitepayRuntime({db,environment:env,activationCheck:async()=>{enter();await barrier;return true;},
        checkoutClient:{async createCheckout(){sentAfterAcknowledgement=acknowledged;return {checkoutUrl:'https://checkout.infinitepay.io/SYNTHETIC-DISABLE-RACE'};}},
        checkClient:{async checkPayment(){return {paid:false};}},parseEvent:()=>({}),deliver:async()=>{},
        redirectUrl:env.INFINITEPAY_PUBLIC_ORIGIN+'/pagamentos/infinitepay/retorno',webhookUrl:env.INFINITEPAY_PUBLIC_ORIGIN+'/pagamentos/infinitepay/webhook',successUrl:env.INFINITEPAY_SUCCESS_URL});
    const result=runtime.finishCreation(reservation);await entered;
    const disable=db.raw('UPDATE config_infinitepay SET ativo=false WHERE id=1 /* F5A_DISABLE_BARRIER_504 */').then(()=>{acknowledged=true;});
    let observed=false;
    try {
        for(let n=0;n<100;n++) {
            if(acknowledged) {observed=true;break;}
            const waiting=await db.raw("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE '%F5A_DISABLE_BARRIER_504%'");
            if(waiting.rows.length) {observed=true;break;}
            await new Promise(resolve=>setTimeout(resolve,5));
        }
    } finally {release();}
    await result;await disable;
    assert.equal(observed,true);assert.equal(acknowledged,true);assert.equal(sentAfterAcknowledgement,false);
    assert.equal((await db('config_infinitepay').first()).ativo,false);
});
test('shutdown waits for processing, closes creation and leaves evidence for restart', async () => {
    await service.stop(); assert.equal(await service.runtime.checkoutEnabled(),false);
    assert.equal(service.status().running,false);
    assert.equal((await db('pagamentos').where({ pedido_id:501 }).first()).status,'PAGA');
    await assert.rejects(service.assertReady(db,await db('config_infinitepay').first()));
    const next = await initialize({ app:{locals:{}}, db, env, transport, now:clock }); service=next; service.start({intervalMs:20});
    await service.runtime.processPending(); assert.equal(Number((await db('infinitepay_entregas_homologacao').count('* as n').first()).n),1);
});

});
