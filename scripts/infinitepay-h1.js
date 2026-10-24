import knex from 'knex';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { validateH1Settings, assertH1Database, createH1App, listenH1, prepareH1ReturnProbe, H1_WEBHOOK, H1_RETURN } from '../src/homologation/infinitepayH1.js';

const action = process.argv[2];
let db, server;
const digest = value => createHash('sha256').update(value).digest('hex');
async function main() {
    if (!['serve', 'status', 'verify'].includes(action) || !process.env.H1_SETTINGS_FILE) throw new Error();
    const settings = JSON.parse((await readFile(process.env.H1_SETTINGS_FILE, 'utf8')).replace(/^\uFEFF/, ''));
    validateH1Settings(settings);
    if (!process.env.H1_DB_PASSWORD || !/^[A-Za-z0-9+/]{43}=$/.test(process.env.H1_OBSERVATION_KEY || '')) throw new Error();
    const captureKey = Buffer.from(process.env.H1_OBSERVATION_KEY, 'base64');
    db = knex({ client: 'pg', connection: { host: settings.host, port: settings.port, database: settings.database,
        user: settings.user, password: process.env.H1_DB_PASSWORD, ssl: false, application_name: 'infinitepay-h1-local' },
        pool: { min: 0, max: 4 }, acquireConnectionTimeout: 5000 });
    delete process.env.H1_DB_PASSWORD; delete process.env.H1_OBSERVATION_KEY;
    const identity = await assertH1Database(db);
    const expected = (await readdir(new URL('../src/database/migrations/', import.meta.url))).filter(name => name.endsWith('.js')).sort();
    const applied = (await db('knex_migrations').select('name')).map(row => row.name).sort();
    assert.deepEqual(applied, expected);
    if (action === 'status') {
        console.info(JSON.stringify({ database: identity, migrations: applied.length, checkout_enabled: false,
            events: await db('pagamentos_eventos').select('tipo_evento', 'status_processamento').count('* as total').groupBy('tipo_evento', 'status_processamento'),
            link_dispatch_reservations: Number((await db('pagamentos_eventos').where({ event_key: 'h1:links:dispatch-budget' }).count('* as n').first()).n),
            orders: Number((await db('pedidos').count('* as n').first()).n),
            released_orders: Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n),
            outbox: Number((await db('outbox_eventos').count('* as n').first()).n) }, null, 2));
        return;
    }
    const publicUrl = new URL(settings.public_origin);
    if (publicUrl.protocol !== 'https:' || publicUrl.origin !== settings.public_origin || !publicUrl.hostname.endsWith('.trycloudflare.com')) throw new Error();
    if (action === 'serve') {
        const app = createH1App({ db, captureKey, publicOrigin: settings.public_origin });
        server = await listenH1(app, { onReady: async () => {
            settings.backend_pid = process.pid;
            await writeFile(process.env.H1_SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
        } });
        console.info(JSON.stringify({ status: 'H1_READY', database: identity.database, migrations: applied.length,
            listen: '127.0.0.1:55441', public_origin: settings.public_origin, checkout_enabled: false, financial_transport_enabled: false }));
        let stopping = false;
        const stop = async () => {
            if (stopping) return; stopping = true;
            await new Promise(resolve => server.close(resolve)); await db.destroy(); captureKey.fill(0);
        };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return 'serving';
    }
    async function call(path, options = {}, expectedStatus) {
        const response = await fetch(settings.public_origin + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
        assert.equal(response.status, expectedStatus, 'HTTP inesperado na validação H1');
        return response;
    }
    const before = { outbox: Number((await db('outbox_eventos').count('* as n').first()).n),
        released: Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n) };
    assert.equal(before.outbox, 0); assert.equal(before.released, 0);
    assert.equal(Number((await db('pagamentos_eventos').where({ event_key: 'h1:links:dispatch-budget' }).count('* as n').first()).n), 0);
    const landing = await call(H1_RETURN, {}, 200);
    assert.match(await landing.text(), /não confirma pagamento/);
    for (const path of ['/', '/qz', '/pedidos', '/socket.io/', '/pagamentos/retomar']) await call(path, {}, 404);
    await call(H1_WEBHOOK, {}, 405);
    await call(H1_RETURN, { method: 'POST' }, 405);
    await call(H1_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415);
    await call(H1_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400);
    const body = JSON.stringify({ h1_simulation: randomUUID(), unhomologated_shape: { paid: true, marker: 'SYNTHETIC_ONLY' } });
    for (let i = 0; i < 2; i++) await call(H1_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 200);
    const captures = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_WEBHOOK' })
        .whereRaw("payload_filtrado->>'body_sha256' = ?", [digest(body)]);
    assert.equal(captures.length, 1); assert.equal(captures[0].status_processamento, 'PENDENTE_IDENTIFICACAO');
    assert.equal(captures[0].pagamento_id, null); assert.equal(captures[0].payload_filtrado.body, undefined);
    const { payment, nonce, orderNsu } = await prepareH1ReturnProbe(db);
    const redirected = await call(H1_RETURN + '?' + new URLSearchParams({ r: nonce, order_nsu: orderNsu,
        transaction_nsu: 'H1-SIMULATED-TRANSACTION', slug: 'H1-SIMULATED-SLUG' }), {}, 303);
    const location = new URL(redirected.headers.get('location'));
    assert.equal(location.origin, settings.public_origin); assert.equal(location.pathname, H1_RETURN);
    await call(location.pathname + location.search, {}, 200);
    assert.equal((await db('pagamentos').where({ id: payment.id }).first('status')).status, 'FALHOU');
    assert.equal((await db('pedidos').where({ id: payment.pedido_id }).first('liberado_cozinha_em')).liberado_cozinha_em, null);
    assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    assert.equal(Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n), 0);
    assert.equal((await db('config_infinitepay').first('ativo')).ativo, false);
    const verification = { checked_at: new Date().toISOString(), public_origin: settings.public_origin,
        database: identity, migrations: applied.length, https: true, webhook_persisted: true, webhook_deduplicated: true,
        correlated_return: true, simulated_payment_status: 'FALHOU', kitchen_released: false, real_provider_calls: 0 };
    settings.last_verification = verification;
    await writeFile(process.env.H1_SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.info(JSON.stringify(verification, null, 2));
}
try {
    const result = await main();
    if (result !== 'serving' && db) await db.destroy();
} catch {
    console.error(JSON.stringify({ status: 'H1_BLOCKED', message: 'Falha na validação ou execução local H1; nenhuma cobrança foi autorizada por este comando.' }));
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (db) await db.destroy();
    process.exitCode = 1;
}
