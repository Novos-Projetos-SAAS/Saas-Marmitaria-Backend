import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { createPaymentOrchestrator } from '../services/paymentOrchestrator.js';
import { encryptApiKey, decryptApiKey } from '../utils/infinitepayCredentials.js';
import { createH1ObservationAdapters, encryptH1Observation, decryptH1Observation, prepareH1ReturnProbe, H1_WEBHOOK, H1_RETURN } from './infinitepayH1.js';

const commandKey = 'h1:links:command-reservation', budgetKey = 'h1:links:dispatch-budget';
const digest = value => createHash('sha256').update(value).digest('hex');
const blocked = () => new Error('Comando H1 bloqueado. Consulte o resultado; não repita um envio financeiro.');
function origin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) throw blocked();
    return value;
}

export async function confirmH1Link({ input = process.stdin, output = process.stdout, publicOrigin }) {
    origin(publicOrigin);
    if (input.isTTY !== true || output.isTTY !== true) throw blocked();
    const terminal = createInterface({ input, output, terminal: false });
    try {
        output.write('H1: criar um único link de R$ 1,00 (100 centavos).\n' +
            'Banco: 127.0.0.1:55440/infinitepay_h1_homologacao\n' +
            'POST: https://api.checkout.infinitepay.io/links\n' +
            'Webhook: ' + publicOrigin + H1_WEBHOOK + '\nRetorno: ' + publicOrigin + H1_RETURN + '\n' +
            'Credencial: somente API Key local protegida. Não será iniciado pagamento.\n');
        return await terminal.question('Digite exatamente CRIAR H1 100 CENTAVOS para autorizar este único POST: ') === 'CRIAR H1 100 CENTAVOS';
    } finally { terminal.close(); }
}

export async function verifyH1Endpoints({ db, publicOrigin, transport = globalThis.fetch }) {
    origin(publicOrigin);
    async function call(path, options = {}, expectedStatus) {
        const response = await transport(publicOrigin + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
        assert.equal(response.status, expectedStatus, 'HTTP inesperado na validação H1');
        return response;
    }
    assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    assert.equal(Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n), 0);
    assert.equal(Number((await db('pagamentos_eventos').where({ event_key: budgetKey }).count('* as n').first()).n), 0);
    const landing = await call(H1_RETURN, {}, 200);
    assert.match(await landing.text(), /não confirma pagamento/);
    for (const path of ['/', '/qz', '/pedidos', '/socket.io/', '/pagamentos/retomar']) await call(path, {}, 404);
    await call(H1_WEBHOOK, {}, 405); await call(H1_RETURN, { method: 'POST' }, 405);
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
    assert.equal(location.origin, publicOrigin); assert.equal(location.pathname, H1_RETURN);
    await call(location.pathname + location.search, {}, 200);
    assert.equal((await db('pagamentos').where({ id: payment.id }).first('status')).status, 'FALHOU');
    assert.equal((await db('pedidos').where({ id: payment.pedido_id }).first('liberado_cozinha_em')).liberado_cozinha_em, null);
    assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    assert.equal(Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n), 0);
    assert.equal((await db('config_infinitepay').first('ativo')).ativo, false);
    return { checked_at: new Date().toISOString(), public_origin: publicOrigin, https: true, webhook_persisted: true,
        webhook_deduplicated: true, correlated_return: true, simulated_payment_status: 'FALHOU', kitchen_released: false, real_provider_calls: 0 };
}

export async function executeH1SingleLink({ db, captureKey, publicOrigin, handle, apiKey, transport, timeoutMs = 5000 }) {
    origin(publicOrigin);
    if (handle !== 'matheuszxp' || typeof apiKey !== 'string' || !/^[\x21-\x7E]{1,4096}$/.test(apiKey) ||
        typeof transport !== 'function' || !Buffer.isBuffer(captureKey) || captureKey.length !== 32) throw blocked();
    const { checkoutClient } = createH1ObservationAdapters({ db, captureKey, publicOrigin, transport, timeoutMs, allowRealRequests: true });
    const orchestrator = createPaymentOrchestrator({ db, client: checkoutClient, redirectUrl: publicOrigin + H1_RETURN,
        webhookUrl: publicOrigin + H1_WEBHOOK, orderNsuPrefix: 'H1-MARMITARIA' });
    const reservation = await db.transaction(async trx => {
        await trx.raw('SET LOCAL synchronous_commit = on');
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['h1:links:single-command']);
        if (await trx('pagamentos_eventos').whereIn('event_key', [commandKey, budgetKey]).first('id')) return null;
        const config = await trx('config_infinitepay').where({ id: 1 }).forUpdate().first();
        if (!config || config.ativo !== false || config.assured_installments !== 1 || (config.handle !== null && config.handle !== handle)) throw blocked();
        let credentialId = config.credencial_atual_id;
        if (credentialId) {
            const stored = await trx('infinitepay_credenciais').where({ id: credentialId, config_id: 1, handle }).first();
            if (!stored || decryptApiKey(stored, handle) !== apiKey) throw blocked();
        } else {
            const [credential] = await trx('infinitepay_credenciais').insert({ handle, ...encryptApiKey(apiKey, handle) }).returning('id');
            credentialId = credential.id;
        }
        let method = await trx('metodos_pagamento').where({ codigo: 'PIX' }).forUpdate().first();
        if (method && (method.tipo_financeiro !== 'PIX' || method.ativo !== true || method.deletado_em !== null)) throw blocked();
        if (!method) [method] = await trx('metodos_pagamento').insert({ nome: 'H1 PIX ' + randomUUID(), codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
        await trx('config_infinitepay').where({ id: 1 }).update({ handle, credencial_atual_id: credentialId, atualizado_em: trx.fn.now() });
        const [order] = await trx('pedidos').insert({ nome_cliente: 'H1 TESTE DE LINK SEM PAGAMENTO', telefone_cliente: '00000000000',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: '1.00', fluxo_pagamento: 'INFINITEPAY' }).returning('id');
        const [size] = await trx('tamanhos_marmitas').insert({ nome: 'H1 LINK ' + randomUUID(), preco_base: '1.00' }).returning('id');
        await trx('itens_pedido').insert({ pedido_id: order.id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: '1.00', subtotal: '1.00' });
        const reserved = await orchestrator.reserveInTransaction({ pedidoId: order.id, clientRequestId: randomUUID() }, trx);
        await trx('pagamentos_eventos').insert({ event_key: commandKey, tipo_evento: 'H1_RESERVA_COMANDO_LINKS',
            pagamento_id: reserved.attempt.id, status_processamento: 'PENDENTE_IDENTIFICACAO',
            payload_filtrado: encryptH1Observation({ body: JSON.stringify(reserved.payload), headers: {} }, captureKey) });
        return reserved;
    });
    if (reservation) await orchestrator.completeReservation(reservation);
    return { ...await readH1LinkResult({ db, captureKey }), already_reserved: !reservation };
}

export async function readH1LinkResult({ db, captureKey }) {
    const marker = await db('pagamentos_eventos').where({ event_key: commandKey }).first();
    const budget = await db('pagamentos_eventos').where({ event_key: budgetKey }).first('id');
    const payment = marker?.pagamento_id ? await db('pagamentos').where({ id: marker.pagamento_id }).first('status', 'credencial_id', 'handle_snapshot') : null;
    const capture = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_LINKS' }).orderBy('id', 'desc').first();
    const result = { reserved: Boolean(marker || budget), test_amount_centavos: 100, attempt_status: payment?.status ?? null,
        response_received: Boolean(capture), financial_confirmation: false, automatic_retry: false };
    if (!capture) return result;
    const observed = decryptH1Observation(capture.payload_filtrado, captureKey), urls = [];
    const metadata = { ...result, http_status: observed.status, response_bytes: Buffer.byteLength(observed.body) };
    let apiKey;
    try {
        const credential = payment?.credencial_id && await db('infinitepay_credenciais')
            .where({ id: payment.credencial_id, handle: payment.handle_snapshot }).first();
        if (!credential) throw blocked();
        apiKey = decryptApiKey(credential, payment.handle_snapshot);
    } catch { return { ...metadata, details_blocked: 'CREDENTIAL_UNAVAILABLE' }; }
    const secret = name => /api.?key|password|secret|token|authorization/i.test(name) || Boolean(apiKey && name.toLowerCase().includes(apiKey.toLowerCase()));
    function shape(value, path = '$', depth = 0) {
        if (depth > 5) return 'DEPTH_LIMIT';
        if (Array.isArray(value)) return value.slice(0, 3).map((item, i) => shape(item, path + '[' + i + ']', depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([name, item]) => {
            const field = secret(name) || !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(name) ? '[PRIVATE_FIELD]' : name;
            return [field, field === '[PRIVATE_FIELD]' ? 'REDACTED' : shape(item, path + '.' + field, depth + 1)];
        }));
        if (typeof value === 'string' && urls.length < 20 && !secret(value)) {
            try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && !secret(url.origin)) urls.push({ field: path, origin: url.origin }); } catch {}
        }
        return value === null ? 'null' : typeof value;
    }
    let structure;
    try { structure = shape(JSON.parse(observed.body)); } catch { structure = 'NON_JSON'; }
    return { ...metadata, json_structure: structure,
        observed_https_origins_not_validated: urls, contract_review_required: true };
}
