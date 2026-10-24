import knex from 'knex';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { validateH1Settings, assertH1Database, createH1App, listenH1 } from '../src/homologation/infinitepayH1.js';
import { verifyH1Endpoints, confirmH1Link, executeH1SingleLink, readH1LinkResult } from '../src/homologation/infinitepayH1SingleLink.js';

const action = process.argv[2];
let db, server;
async function main() {
    if (!['serve', 'status', 'verify', 'create-link', 'result'].includes(action) || !process.env.H1_SETTINGS_FILE) throw new Error();
    const settings = JSON.parse((await readFile(process.env.H1_SETTINGS_FILE, 'utf8')).replace(/^\uFEFF/, ''));
    validateH1Settings(settings);
    if (!process.env.H1_DB_PASSWORD || !/^[A-Za-z0-9+/]{43}=$/.test(process.env.H1_OBSERVATION_KEY || '')) throw new Error();
    const captureKey = Buffer.from(process.env.H1_OBSERVATION_KEY, 'base64');
    const apiKey = process.env.H1_API_KEY;
    if (action === 'create-link' || action === 'result') {
        process.env.INFINITEPAY_ENCRYPTION_KEYS = JSON.stringify({ 1: captureKey.toString('base64') });
        process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION = '1';
    }
    db = knex({ client: 'pg', connection: { host: settings.host, port: settings.port, database: settings.database,
        user: settings.user, password: process.env.H1_DB_PASSWORD, ssl: false, application_name: 'infinitepay-h1-local' },
        pool: { min: 0, max: 4 }, acquireConnectionTimeout: 5000 });
    delete process.env.H1_DB_PASSWORD; delete process.env.H1_OBSERVATION_KEY; delete process.env.H1_API_KEY;
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
    if (action === 'result') {
        console.info(JSON.stringify(await readH1LinkResult({ db, captureKey }), null, 2));
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
    if (action === 'create-link') {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || settings.handle !== 'matheuszxp' ||
            typeof apiKey !== 'string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey)) throw new Error();
        const existing = await readH1LinkResult({ db, captureKey });
        if (existing.reserved) { console.info(JSON.stringify({ ...existing, already_reserved: true }, null, 2)); return; }
        await verifyH1Endpoints({ db, publicOrigin: settings.public_origin });
        const checkedAt = Date.now();
        if (!await confirmH1Link({ publicOrigin: settings.public_origin })) { console.info(JSON.stringify({ status: 'H1_CANCELLED', financial_request_sent: false })); return; }
        const latest = JSON.parse((await readFile(process.env.H1_SETTINGS_FILE, 'utf8')).replace(/^\uFEFF/, ''));
        validateH1Settings(latest);
        if (latest.public_origin !== settings.public_origin || latest.handle !== settings.handle || Date.now() - checkedAt > 300000) throw new Error();
        await assertH1Database(db);
        console.info(JSON.stringify(await executeH1SingleLink({ db, captureKey, publicOrigin: settings.public_origin,
            handle: settings.handle, apiKey, transport: globalThis.fetch }), null, 2));
        return;
    }
    const verification = { ...await verifyH1Endpoints({ db, publicOrigin: settings.public_origin }), database: identity, migrations: applied.length };
    settings.last_verification = verification;
    await writeFile(process.env.H1_SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.info(JSON.stringify(verification, null, 2));
}
try {
    const result = await main();
    if (result !== 'serving' && db) await db.destroy();
} catch {
    console.error(JSON.stringify({ status: 'H1_BLOCKED', message: 'Operação H1 bloqueada ou interrompida. Consulte Result; não repita um envio financeiro.' }));
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (db) await db.destroy();
    process.exitCode = 1;
}
