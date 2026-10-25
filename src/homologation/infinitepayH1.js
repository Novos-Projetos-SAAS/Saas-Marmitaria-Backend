import express from 'express';
import rateLimit from 'express-rate-limit';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createInfinitepayRuntime } from '../infinitepayRuntime.js';
import paymentRoutes from '../routes/Pagamentos.Routes.js';
import { buildCheckoutPayload, InfinitepayClientError } from '../services/infinitepayClient.js';
import { createInfinitepayCheckClient } from '../services/infinitepayCheckClient.js';
import { h1ProxyHeaders, trustH1Proxy } from './infinitepayH1Proxy.js';

export const H1_WEBHOOK = '/pagamentos/infinitepay/webhook';
export const H1_RETURN = '/pagamentos/infinitepay/retorno';
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => Object.assign(new Error('Homologação H1 indisponível.'), { statusCode: 503 });

export function validateH1Settings(settings, env = process.env) {
    if (!settings || settings.purpose !== 'INFINITEPAY_H1_ONLY' || settings.host !== '127.0.0.1' ||
        settings.port !== 55440 || settings.database !== 'infinitepay_h1_homologacao' || settings.user !== 'codex_h1_owner' ||
        typeof settings.handle !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(settings.handle) ||
        settings.approved_amount_centavos !== 100 || settings.approved_max_real_link_creations !== 1 ||
        env.NODE_ENV !== 'development' || env.INFINITEPAY_CHECKOUT_ENABLED !== 'false' ||
        ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'TEST_DATABASE_URL'].some(name => env[name])) {
        throw unavailable();
    }
}

export async function assertH1Database(db) {
    const { rows: [identity] } = await db.raw('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS host, inet_server_port() AS port');
    const config = await db('config_infinitepay').where({ id: 1 }).first('ativo');
    const { rows: [guard] } = await db.raw("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.config_infinitepay'::regclass AND conname='ip_config_phase1_disabled' AND convalidated) AS present");
    if (identity.database !== 'infinitepay_h1_homologacao' || identity.host !== '127.0.0.1' || identity.port !== 55440 ||
        identity.username !== 'codex_h1_owner' || config?.ativo !== false || guard.present !== true) throw unavailable();
    return identity;
}

function originUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
            !/^[a-z0-9.-]+$/i.test(url.hostname) || ['localhost', '127.0.0.1'].includes(url.hostname)) throw unavailable();
        return url;
    } catch { throw unavailable(); }
}

export function encryptH1Observation(value, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw unavailable();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('infinitepay:h1:observation:v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptH1Observation(envelope, key) {
    try {
        if (!Buffer.isBuffer(key) || key.length !== 32 || envelope?.version !== 1) throw unavailable();
        const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw unavailable();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from('infinitepay:h1:observation:v1')); decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw unavailable(); }
}

function safeHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !/auth|cookie|token|key|secret|credential/i.test(name)));
}

async function observe(db, key, kind, observation) {
    // Forwarder-specific values vary on every delivery and are not provider contract fields.
    const identityHeaders = Object.fromEntries(Object.entries(observation.headers).filter(([name]) =>
        !/^(cf-|x-forwarded-|host$|connection$|accept-encoding$)/i.test(name)).sort(([a], [b]) => a.localeCompare(b)));
    const eventKey = 'h1:' + kind + ':' + digest(JSON.stringify({ body: observation.body, status: observation.status ?? null, headers: identityHeaders }));
    const payload = encryptH1Observation(observation, key);
    payload.body_sha256 = digest(String(observation.body));
    // These are unhomologated captures, never normalized provider events or proof of payment.
    await db.transaction(async trx => {
        await trx.raw('SET LOCAL synchronous_commit = on');
        await trx('pagamentos_eventos').insert({ event_key: eventKey, tipo_evento: 'H1_OBSERVACAO_' + kind,
            payload_filtrado: payload, status_processamento: 'PENDENTE_IDENTIFICACAO', ultimo_erro: 'H1_CONTRACT_NOT_HOMOLOGATED' })
            .onConflict('event_key').ignore();
    });
}

export async function listenH1(app, { port = 55441, onReady = async () => {} } = {}) {
    const server = app.listen(port, '127.0.0.1');
    try {
        await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
        await onReady(server);
        return server;
    } catch (error) {
        if (server.listening) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        throw error;
    }
}

export async function prepareH1ReturnProbe(db) {
    const nonce = randomBytes(32).toString('base64url'), orderNsu = 'H1-SIM-' + randomUUID();
    const payment = await db.transaction(async trx => {
        const [method] = await trx('metodos_pagamento').insert({ nome: 'H1 SIM ' + randomUUID(),
            codigo: 'H1_SIM_' + randomUUID(), tipo_financeiro: 'PIX' }).returning('id');
        const [order] = await trx('pedidos').insert({ nome_cliente: 'H1 SIMULAÇÃO SEM COBRANÇA', telefone_cliente: '00000000000',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: '1.00', fluxo_pagamento: 'INFINITEPAY' }).returning('id');
        const [size] = await trx('tamanhos_marmitas').insert({ nome: 'H1 SIM ' + randomUUID(), preco_base: '1.00' }).returning('id');
        await trx('itens_pedido').insert({ pedido_id: order.id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: '1.00', subtotal: '1.00' });
        const [attempt] = await trx('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1, order_nsu: orderNsu,
            status: 'FALHOU', valor_centavos: 100, valid_until: new Date(Date.now() + 86400000),
            return_nonce_hash: digest(nonce), error_code: 'H1_SIMULATION_ONLY' }).returning('*');
        return attempt;
    });
    return { payment, nonce, orderNsu };
}

export function createH1ObservationAdapters({ db, captureKey, publicOrigin, allowRealRequests = false, transport = globalThis.fetch, timeoutMs = 5000 }) {
    originUrl(publicOrigin);
    if (typeof allowRealRequests !== 'boolean' || typeof transport !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw unavailable();
    async function observedTransport(url, options) {
        if (!allowRealRequests || !['https://api.checkout.infinitepay.io/links', 'https://api.checkout.infinitepay.io/payment_check'].includes(url) ||
            options.method !== 'POST' || options.redirect !== 'error') throw unavailable();
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
        });
        try {
            return await Promise.race([(async () => {
                const response = await transport(url, { ...options, signal });
                const chunks = []; let size = 0;
                if (response.body) for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > 65536 || signal.aborted) { controller.abort(); throw unavailable(); }
                    chunks.push(Buffer.from(chunk));
                }
                if (signal.aborted) throw unavailable();
                const body = Buffer.concat(chunks).toString('utf8');
                await observe(db, captureKey, url.endsWith('/links') ? 'LINKS' : 'PAYMENT_CHECK', {
                    status: response.status, headers: safeHeaders(Object.fromEntries(response.headers)), body });
                if (signal.aborted) throw unavailable();
                return new Response(body, { status: response.status });
            })(), deadline]);
        } finally { clearTimeout(timer); }
    }
    const checkoutClient = { async createCheckout({ apiKey, payload } = {}) {
        let validated;
        try {
            if (!allowRealRequests || typeof apiKey !== 'string' || !/^[\x21-\x7E]+$/.test(apiKey) ||
                typeof payload?.order_nsu !== 'string' || !/^H1-MARMITARIA-[1-9]\d*-T1-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(payload.order_nsu)) throw unavailable();
            const redirect = new URL(payload.redirect_url);
            if (redirect.origin !== publicOrigin || redirect.pathname !== H1_RETURN || redirect.username || redirect.password || redirect.hash ||
                redirect.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(redirect.searchParams.get('r') || '') ||
                payload.webhook?.url !== publicOrigin + H1_WEBHOOK || payload.items?.length !== 1 ||
                payload.items[0].quantity !== 1 || payload.items[0].price !== 100 || payload.options?.assured_installments !== 1 ||
                payload.options?.single_payment !== true || payload.options?.require_delivery_address !== false || payload.options?.discounts !== undefined) throw unavailable();
            validated = buildCheckoutPayload({ orderNsu: payload.order_nsu, items: payload.items,
                redirectUrl: payload.redirect_url, webhookUrl: payload.webhook.url, validUntil: payload.options.valid_until });
            validated.options.payment_methods_enabled = ['credit_card', 'pix'];
        } catch { throw new InfinitepayClientError('INFINITEPAY_INVALID_INPUT', 'FALHOU'); }
        try {
            // One durable dispatch budget for the entire H1 database, including restarts and uncertain outcomes.
            await db.transaction(async trx => {
                await trx.raw('SET LOCAL synchronous_commit = on');
                await trx('pagamentos_eventos').insert({ event_key: 'h1:links:dispatch-budget', tipo_evento: 'H1_RESERVA_ENVIO_LINKS',
                    payload_filtrado: { version: 1, amount: 100 }, status_processamento: 'PENDENTE_IDENTIFICACAO' });
            });
        } catch { throw new InfinitepayClientError('INFINITEPAY_NOT_CONFIGURED', 'FALHOU'); }
        try {
            await observedTransport('https://api.checkout.infinitepay.io/links', { method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey }, body: JSON.stringify(validated), redirect: 'error' });
        } catch { /* A durable reservation is never retried automatically. */ }
        // Until a real response is reviewed, no field or external URL is accepted as a checkout contract.
        throw new InfinitepayClientError('INFINITEPAY_REQUEST_UNCERTAIN', 'INCERTA');
    } };
    const checkClient = createInfinitepayCheckClient({ transport: observedTransport, timeoutMs,
        parsePaymentCheck: () => { throw unavailable(); } });
    return { checkoutClient, checkClient };
}

export function createH1App({ db, captureKey, publicOrigin, verifyProxy = async () => false, log = entry => console.info(JSON.stringify(entry)) }) {
    const origin = originUrl(publicOrigin);
    if (!Buffer.isBuffer(captureKey) || captureKey.length !== 32 || typeof log !== 'function') throw unavailable();
    const app = express(); app.disable('x-powered-by');
    app.set('trust proxy', trustH1Proxy);
    const adapters = createH1ObservationAdapters({ db, captureKey, publicOrigin });
    const runtime = createInfinitepayRuntime({ db, ...adapters, redirectUrl: publicOrigin + H1_RETURN,
        webhookUrl: publicOrigin + H1_WEBHOOK, successUrl: publicOrigin + H1_RETURN, statusReferenceInFragment: false,
        parseEvent: () => { throw unavailable(); }, deliver: async () => { throw unavailable(); } });
    app.locals.infinitepayRuntime = runtime;
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
        const route = req.path === H1_WEBHOOK ? H1_WEBHOOK : req.path === H1_RETURN ? H1_RETURN : null;
        res.once('finish', () => log({ method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'].includes(req.method) ? req.method : 'UNKNOWN',
            route: route || '[unmatched]', status: res.statusCode }));
        if (req.get('host') !== origin.host && req.get('host') !== '127.0.0.1:' + req.socket.localPort) return res.status(421).end();
        if (!route) return res.status(404).end();
        const method = route === H1_WEBHOOK ? 'POST' : 'GET';
        if (req.method !== method) return res.set('Allow', method).status(405).end();
        req.auditBase = '/pagamentos'; next();
    });
    app.use(h1ProxyHeaders({ publicHost: origin.host, verifyProxy }));
    app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
    app.post(H1_WEBHOOK, (req, res, next) => {
        if (!req.is('application/json')) return res.status(415).json({ status: 'fail' });
        next();
    }, express.json({ limit: 32768, inflate: false, verify: (req, res, buffer) => { req.h1Body = buffer.toString('utf8'); } }), async (req, res) => {
        if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') return res.status(400).json({ status: 'fail' });
        try {
            await observe(db, captureKey, 'WEBHOOK', { body: req.h1Body, headers: safeHeaders(req.headers) });
            res.status(200).json({ status: 'accepted' });
        } catch { throw unavailable(); }
    });
    app.get(H1_RETURN, async (req, res, next) => {
        if (Object.keys(req.query).some(name => name !== 'ref')) {
            await observe(db, captureKey, 'RETURN', { body: JSON.stringify(req.query), headers: safeHeaders(req.headers) });
        }
        if (Object.keys(req.query).length === 0 || (Object.keys(req.query).length === 1 && typeof req.query.ref === 'string')) {
            if (req.query.ref) await runtime.authorize(req.query.ref, 'STATUS');
            return res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Homologação H1</title><p>Endpoint de retorno H1 acessível. O recebimento não confirma pagamento.</p></html>');
        }
        next();
    });
    app.use('/pagamentos', paymentRoutes);
    app.use((error, req, res, next) => {
        const status = [400, 404, 413, 415, 429].includes(error.statusCode || error.status) ? (error.statusCode || error.status) : 503;
        res.status(status).json({ status: 'fail', message: 'Falha na homologação H1.' });
    });
    return app;
}
