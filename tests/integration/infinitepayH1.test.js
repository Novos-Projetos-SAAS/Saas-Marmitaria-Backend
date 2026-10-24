import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createDecipheriv } from 'node:crypto';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const origin = 'https://h1.invalid.test';
const webhook = '/pagamentos/infinitepay/webhook', retorno = '/pagamentos/infinitepay/retorno';
const digest = value => createHash('sha256').update(value).digest('hex');

describe('H1 isolated observation server, no financial approval', { concurrency: false }, () => {
    let fixture, db, module, server, base, captureKey, logs, now;
    before(async () => {
        module = await import('../../src/homologation/infinitepayH1.js');
        fixture = await createTestDatabase(); db = fixture.db; await db.migrate.latest();
        captureKey = randomBytes(32); logs = []; now = new Date();
        server = module.createH1App({ db, captureKey, publicOrigin: origin, log: entry => logs.push(entry) }).listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = 'http://127.0.0.1:' + server.address().port;
    });
    after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (fixture) await fixture.close();
    });
    function open(row) {
        const envelope = row.payload_filtrado;
        const decipher = createDecipheriv('aes-256-gcm', captureKey, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from('infinitepay:h1:observation:v1'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    }
    const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    test('direct callers cannot forge Cloudflare or forwarded identity, even using the public Host', async () => {
        for (const headers of [
            { 'X-Forwarded-For': '203.0.113.1' },
            { 'CF-Connecting-IP': '203.0.113.2' },
            { Host: new URL(origin).host, 'CF-Connecting-IP': '203.0.113.3', 'X-Forwarded-For': '203.0.113.4' }
        ]) assert.equal((await request(retorno, { headers })).status, 403);
    });
    test('only a verified tunnel connection uses CF-Connecting-IP; injected XFF does not reset its rate limit', async () => {
        let verified = true;
        const app = module.createH1App({ db, captureKey, publicOrigin: origin, log: () => {},
            verifyProxy: async () => verified });
        assert.notEqual(app.get('trust proxy'), true);
        const proxyServer = app.listen(0, '127.0.0.1');
        await new Promise(resolve => proxyServer.once('listening', resolve));
        const url = 'http://127.0.0.1:' + proxyServer.address().port + retorno;
        const call = (ip, forged) => new Promise((resolve, reject) => {
            const req = httpRequest(url, { headers: { Host: new URL(origin).host,
                'CF-Connecting-IP': ip, 'X-Forwarded-For': forged, Forwarded: 'for=203.0.113.99' } }, res => {
                res.resume(); res.once('end', () => resolve({ status: res.statusCode, headers: new Map(Object.entries(res.headers)) }));
            }); req.once('error', reject); req.end();
        });
        try {
            const a = await call('203.0.113.20', '198.51.100.1');
            const b = await call('203.0.113.20', '198.51.100.2');
            const c = await call('203.0.113.21', '198.51.100.2');
            assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
            assert.equal(Number(b.headers.get('ratelimit-remaining')), Number(a.headers.get('ratelimit-remaining')) - 1);
            assert.equal(c.headers.get('ratelimit-remaining'), a.headers.get('ratelimit-remaining'));
            for (let i = 0; i < 118; i++) assert.equal((await call('203.0.113.20', '198.51.100.' + (i + 3))).status, 200);
            assert.equal((await call('203.0.113.20', '192.0.2.1')).status, 429);
            assert.equal((await call('bad-ip', '192.0.2.1')).status, 403);
            verified = false;
            assert.equal((await call('203.0.113.21', '192.0.2.1')).status, 403);
            verified = true;
            assert.equal((await call('2001:db8::1', '192.0.2.1')).status, 200);
            assert.equal((await call('2001:db8::2', '192.0.2.2')).headers.get('ratelimit-remaining'), '118');
        } finally { proxyServer.closeAllConnections(); await new Promise(resolve => proxyServer.close(resolve)); }
    });
    test('startup settings refuse production, test mode, activation and any database fallback', () => {
        const settings = { purpose: 'INFINITEPAY_H1_ONLY', host: '127.0.0.1', port: 55440,
            database: 'infinitepay_h1_homologacao', user: 'codex_h1_owner', handle: 'matheuszxp',
            approved_amount_centavos: 100, approved_max_real_link_creations: 1 };
        const env = { NODE_ENV: 'development', INFINITEPAY_CHECKOUT_ENABLED: 'false' };
        assert.doesNotThrow(() => module.validateH1Settings(settings, env));
        for (const update of [{ host: 'remote.example' }, { port: 5432 }, { database: 'production' }, { purpose: 'OTHER' },
            { handle: '' }, { approved_amount_centavos: 200 }, { approved_max_real_link_creations: 2 }]) {
            assert.throws(() => module.validateH1Settings({ ...settings, ...update }, env));
        }
        for (const update of [{ NODE_ENV: 'test' }, { NODE_ENV: 'production' }, { INFINITEPAY_CHECKOUT_ENABLED: 'true' },
            { DATABASE_URL: 'postgresql://production' }, { PGHOST: 'remote.example' }]) {
            assert.throws(() => module.validateH1Settings(settings, { ...env, ...update }));
        }
    });
    test('only exact webhook POST and return GET are reachable, including HEAD rejection', async () => {
        for (const path of ['/', '/qz', '/api-docs', '/socket.io/', '/pedidos', '/pagamentos/retomar', webhook + '/', '/pagamentos//infinitepay/webhook']) {
            assert.equal((await request(path)).status, 404);
        }
        for (const [path, method] of [[webhook, 'GET'], [webhook, 'PUT'], [retorno, 'POST'], [retorno, 'HEAD'], [retorno, 'OPTIONS']]) {
            assert.equal((await request(path, { method })).status, 405);
        }
        const response = await request(retorno);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /não confirma pagamento/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    });
    test('invalid JSON, media type, arrays and oversized payloads are not acknowledged', async () => {
        for (const [body, contentType, expected] of [['{}', 'text/plain', 415], ['{', 'application/json', 400],
            ['[]', 'application/json', 400], [JSON.stringify({ value: 'x'.repeat(33000) }), 'application/json', 413]]) {
            assert.equal((await request(webhook, { method: 'POST', headers: { 'Content-Type': contentType }, body })).status, expected);
        }
    });
    test('unknown simulated provider shape is durably encrypted and deduplicated without assuming a financial event', async () => {
        const simulationId = randomUUID();
        const body = JSON.stringify({ simulation_id: simulationId, unknown_contract: { secret: 'SYNTHETIC_BODY_PRIVATE', paid: true } });
        for (let i = 0; i < 2; i++) {
            const response = await request(webhook + '?token=SYNTHETIC_QUERY_PRIVATE', { method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'SYNTHETIC_AUTH_PRIVATE', 'X-Api-Key': 'SYNTHETIC_KEY_PRIVATE',
                    'X-Provider-Signature': 'SYNTHETIC_SIGNATURE' }, body });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { status: 'accepted' });
        }
        const rows = (await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_WEBHOOK' })).filter(row => open(row).body === body);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].tipo_evento, 'H1_OBSERVACAO_WEBHOOK');
        assert.equal(rows[0].status_processamento, 'PENDENTE_IDENTIFICACAO');
        assert.equal(rows[0].pagamento_id, null);
        assert.equal(rows[0].tentativas, 0);
        assert.equal(JSON.stringify(rows[0]).includes('SYNTHETIC_BODY_PRIVATE'), false);
        const observed = open(rows[0]);
        assert.equal(observed.body, body);
        assert.equal(observed.headers['x-provider-signature'], 'SYNTHETIC_SIGNATURE');
        for (const secret of ['SYNTHETIC_AUTH_PRIVATE', 'SYNTHETIC_KEY_PRIVATE', 'SYNTHETIC_QUERY_PRIVATE']) {
            assert.equal(JSON.stringify(observed).includes(secret), false);
        }
        assert.equal(JSON.stringify(logs).includes('SYNTHETIC'), false);
        const tampered = structuredClone(rows[0]); tampered.payload_filtrado.tag = randomBytes(16).toString('base64');
        assert.throws(() => open(tampered));
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    });
    test('a changed provider signature is retained while an identical webhook remains deduplicated', async () => {
        const body = JSON.stringify({ simulation_id: randomUUID() });
        for (const signature of ['SYNTHETIC-A', 'SYNTHETIC-B', 'SYNTHETIC-B']) {
            assert.equal((await request(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Provider-Signature': signature }, body })).status, 200);
        }
        const rows = (await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_WEBHOOK' })).filter(row => open(row).body === body);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map(row => open(row).headers['x-provider-signature']).sort(), ['SYNTHETIC-A', 'SYNTHETIC-B']);
    });
    test('failure to persist startup state closes the HTTP listener before reporting a blocked startup', async () => {
        let port;
        await assert.rejects(module.listenH1(createStandaloneApp(), { port: 0, onReady: async server => {
            port = server.address().port; throw new Error('SYNTHETIC_STATE_WRITE_FAILURE');
        } }));
        assert.ok(port);
        await assert.rejects(fetch('http://127.0.0.1:' + port + retorno));
        function createStandaloneApp() { return module.createH1App({ db, captureKey, publicOrigin: origin, log: () => {} }); }
    });
    test('repeatable return probes preserve previous synthetic orders and use unique method names', async () => {
        const first = await module.prepareH1ReturnProbe(db);
        const before = await db('pedidos').where({ id: first.payment.pedido_id }).first();
        const second = await module.prepareH1ReturnProbe(db);
        assert.notEqual(first.payment.pedido_id, second.payment.pedido_id);
        assert.notEqual(first.orderNsu, second.orderNsu);
        assert.deepEqual(await db('pedidos').where({ id: first.payment.pedido_id }).first(), before);
        for (const probe of [first, second]) {
            assert.match(probe.orderNsu, /^H1-SIM-/);
            assert.equal(probe.payment.status, 'FALHOU');
            assert.equal(probe.payment.error_code, 'H1_SIMULATION_ONLY');
            assert.equal(probe.payment.credencial_id, null);
            assert.equal((await db('itens_pedido').where({ pedido_id: probe.payment.pedido_id }).first()).subtotal, '1.00');
            assert.equal((await db('pedidos').where({ id: probe.payment.pedido_id }).first()).liberado_cozinha_em, null);
        }
    });
    test('a tunnel discovery timeout stops its process and invalidates an older origin instead of reusing it', () => {
        const scriptPath = fileURLToPath(new URL('../../scripts/infinitepay-h1.ps1', import.meta.url));
        const source = String.raw`
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:H1_SCRIPT_UNDER_TEST, [ref]$null, [ref]$null)
foreach ($name in @('Set-H1Property', 'Resolve-H1TunnelOrigin')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw 'Função de controle do túnel ausente' }
    Invoke-Expression $definition.Extent.Text
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('h1-tunnel-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $script:statePath = Join-Path $testRoot 'state.json'
    $script:settings = [pscustomobject]@{ public_origin='https://old.invalid.test'; tunnel_pid=1; tunnel_origin_pid=1 }
    $logPath = Join-Path $testRoot 'tunnel.log'
    Set-Content -LiteralPath $logPath -Value ''
    $fake = [pscustomobject]@{ HasExited=$false; Id=123; killed=$false }
    $fake | Add-Member -MemberType ScriptMethod -Name Kill -Value { $this.killed=$true }
    $failed=$false
    try { Resolve-H1TunnelOrigin $fake $logPath 10 | Out-Null } catch { $failed=$true }
    if (-not $failed -or -not $fake.killed -or $settings.public_origin -or $settings.tunnel_pid -or $settings.tunnel_origin_pid) { throw 'Timeout deixou processo ou origem antiga utilizável' }
    Set-Content -LiteralPath $logPath -Value 'Created https://new-synthetic.trycloudflare.com'
    $fake.killed=$false
    $url = Resolve-H1TunnelOrigin $fake $logPath 10
    if ($url -ne 'https://new-synthetic.trycloudflare.com' -or $fake.killed) { throw 'URL descoberta corretamente foi rejeitada' }
} finally {
    Remove-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:statePath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot
}`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
            encoding: 'utf8', env: { ...process.env, H1_SCRIPT_UNDER_TEST: scriptPath }, timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
    });
    test('database write failure returns 503 instead of a false receipt acknowledgement', async () => {
        await db.transaction(async trx => {
            await trx.raw('SET TRANSACTION READ ONLY');
            const failedServer = module.createH1App({ db: trx, captureKey, publicOrigin: origin, log: () => {} }).listen(0, '127.0.0.1');
            await new Promise(resolve => failedServer.once('listening', resolve));
            try {
                const response = await fetch('http://127.0.0.1:' + failedServer.address().port + webhook, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simulation_id: randomUUID() }) });
                assert.equal(response.status, 503);
                assert.equal((await response.text()).includes('accepted'), false);
            } finally { await new Promise(resolve => failedServer.close(resolve)); }
        });
    });
    test('an unhomologated return is encrypted before correlation rejects it, preserving evidence without approving payment', async () => {
        const marker = 'SYNTHETIC_RETURN_PRIVATE_' + randomUUID();
        const response = await request(retorno + '?' + new URLSearchParams({ unexpected_provider_field: marker }));
        assert.equal(response.status, 400);
        const rows = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_RETURN' });
        const captured = rows.filter(row => open(row).body.includes(marker));
        assert.equal(captured.length, 1);
        assert.equal(captured[0].status_processamento, 'PENDENTE_IDENTIFICACAO');
        assert.equal(JSON.stringify(captured[0]).includes(marker), false);
        assert.equal(JSON.stringify(logs).includes(marker), false);
        assert.equal(Number((await db('pedidos').whereNotNull('liberado_cozinha_em').count('* as n').first()).n), 0);
    });
    test('correlated synthetic return reuses runtime validation and never approves payment or dispatches kitchen events', async () => {
        const [method] = await db('metodos_pagamento').insert({ nome: 'Método H1 sintético', codigo: 'PIX', tipo_financeiro: 'PIX' }).returning('*');
        const [order] = await db('pedidos').insert({ nome_cliente: 'H1 SIMULAÇÃO', telefone_cliente: '00000000000',
            tipo_pedido: 'Remoto', metodo_entrega: 'Retirada', metodo_pagamento_id: method.id, valor_total: '1.00', fluxo_pagamento: 'INFINITEPAY' }).returning('*');
        const nonce = randomBytes(32).toString('base64url'), orderNsu = 'H1-SIM-' + randomUUID();
        const [payment] = await db('pagamentos').insert({ pedido_id: order.id, tentativa_numero: 1, order_nsu: orderNsu,
            status: 'FALHOU', valor_centavos: 100, valid_until: new Date(now.getTime() + 86400000),
            return_nonce_hash: digest(nonce), error_code: 'H1_SIMULATION_ONLY' }).returning('*');
        assert.equal((await request(retorno + '?r=wrong&order_nsu=' + orderNsu)).status, 400);
        const response = await request(retorno + '?' + new URLSearchParams({ r: nonce, order_nsu: orderNsu,
            transaction_nsu: 'SIMULATED-TRANSACTION', slug: 'SIMULATED-SLUG' }));
        assert.equal(response.status, 303);
        const target = new URL(response.headers.get('location'));
        assert.equal(target.origin + target.pathname, origin + retorno);
        assert.equal(target.searchParams.size, 1); assert.ok(target.searchParams.get('ref'));
        assert.equal((await request(target.pathname + target.search)).status, 200);
        assert.equal((await request(retorno + '?ref=invalid')).status, 404);
        assert.equal((await db('pagamentos').where({ id: payment.id }).first()).status, 'FALHOU');
        assert.equal((await db('pedidos').where({ id: order.id }).first()).liberado_cozinha_em, null);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
    });
    test('observation adapters are blocked by default without invoking a network transport', async () => {
        let calls = 0;
        const adapters = module.createH1ObservationAdapters({ db, captureKey, publicOrigin: origin,
            transport: async () => { calls++; throw new Error('should not dispatch'); } });
        await assert.rejects(adapters.checkoutClient.createCheckout({}), error => error.outcome === 'FALHOU');
        await assert.rejects(adapters.checkClient.checkPayment({ apiKey: 'SYNTHETIC_ONLY', handle: 'synthetic',
            orderNsu: 'H1-TEST', transactionNsu: 'SYNTHETIC-TXN', invoiceSlug: 'SYNTHETIC-SLUG' }));
        assert.equal(calls, 0);
    });
    test('authorized simulated /links observation consumes one durable budget, captures unknown response and remains INCERTA', async () => {
        const { buildCheckoutPayload, checkoutValidUntil } = await import('../../src/services/infinitepayClient.js');
        let calls = 0;
        const adapters = module.createH1ObservationAdapters({ db, captureKey, publicOrigin: origin, allowRealRequests: true,
            transport: async (url, options) => {
                calls++; assert.equal(url, 'https://api.checkout.infinitepay.io/links');
                assert.equal(options.headers['X-Api-Key'], 'SYNTHETIC_ONLY');
                assert.equal(options.redirect, 'error');
                const payload = JSON.parse(options.body);
                assert.deepEqual(payload.options.payment_methods_enabled, ['credit_card', 'pix']);
                return new Response(JSON.stringify({ unknown_url_field: 'https://untrusted.invalid.test/pay', extra_id: 'SYNTHETIC_ID' }),
                    { status: 201, headers: { 'Content-Type': 'application/json' } });
            } });
        const payload = buildCheckoutPayload({ orderNsu: 'H1-MARMITARIA-42-T1-' + randomUUID(),
            items: [{ quantity: 1, price: 100, description: 'H1 sintético' }], validUntil: checkoutValidUntil(now),
            redirectUrl: origin + retorno + '?r=' + randomBytes(32).toString('base64url'), webhookUrl: origin + webhook, now });
        for (const change of [{ items: [{ quantity: 1, price: 200, description: 'wrong' }] },
            { redirect_url: 'https://production.invalid.test/return' }, { order_nsu: 'PED-1' }]) {
            await assert.rejects(adapters.checkoutClient.createCheckout({ apiKey: 'SYNTHETIC_ONLY', payload: { ...payload, ...change } }),
                error => error.outcome === 'FALHOU');
        }
        assert.equal(calls, 0);
        const concurrent = await Promise.allSettled(Array.from({ length: 2 }, () => adapters.checkoutClient.createCheckout({ apiKey: 'SYNTHETIC_ONLY', payload })));
        assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.outcome === 'INCERTA').length, 1);
        await assert.rejects(adapters.checkoutClient.createCheckout({ apiKey: 'SYNTHETIC_ONLY', payload }));
        assert.equal(calls, 1);
        const observed = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_LINKS' }).first();
        assert.equal(open(observed).status, 201);
        assert.equal(JSON.parse(open(observed).body).extra_id, 'SYNTHETIC_ID');
        assert.equal(JSON.stringify(observed).includes('SYNTHETIC_ID'), false);
        assert.equal((await db('config_infinitepay').first()).ativo, false);
    });
    test('network failure and a hanging response body consume the dispatch budget without retrying or exposing errors', async () => {
        const { buildCheckoutPayload, checkoutValidUntil } = await import('../../src/services/infinitepayClient.js');
        for (const failure of ['network', 'body']) {
            const isolated = await createTestDatabase();
            try {
                await isolated.db.migrate.latest();
                let calls = 0;
                const adapters = module.createH1ObservationAdapters({ db: isolated.db, captureKey, publicOrigin: origin,
                    allowRealRequests: true, timeoutMs: 25, transport: async () => {
                        calls++;
                        if (failure === 'network') throw new Error('SYNTHETIC_NETWORK_SECRET');
                        return new Response(new ReadableStream({ start() {} }), { status: 200 });
                    } });
                const instant = new Date();
                const payload = buildCheckoutPayload({ orderNsu: 'H1-MARMITARIA-42-T1-' + randomUUID(),
                    items: [{ quantity: 1, price: 100, description: 'H1 sintético' }], validUntil: checkoutValidUntil(instant),
                    redirectUrl: origin + retorno + '?r=' + randomBytes(32).toString('base64url'), webhookUrl: origin + webhook, now: instant });
                await assert.rejects(adapters.checkoutClient.createCheckout({ apiKey: 'SYNTHETIC_ONLY', payload }),
                    error => error.outcome === 'INCERTA' && !error.message.includes('SYNTHETIC'));
                await assert.rejects(adapters.checkoutClient.createCheckout({ apiKey: 'SYNTHETIC_ONLY', payload }));
                assert.equal(calls, 1);
                assert.equal(Number((await isolated.db('pagamentos_eventos').where({ event_key: 'h1:links:dispatch-budget' }).count('* as n').first()).n), 1);
            } finally { await isolated.close(); }
        }
    });
    test('payment_check observation has no speculative response parser and cannot establish paid proof', async () => {
        let calls = 0;
        const adapters = module.createH1ObservationAdapters({ db, captureKey, publicOrigin: origin, allowRealRequests: true,
            transport: async (url, options) => {
                calls++; assert.equal(url, 'https://api.checkout.infinitepay.io/payment_check');
                assert.deepEqual(JSON.parse(options.body), { handle: 'synthetic', order_nsu: 'H1-TEST', transaction_nsu: 'SYNTHETIC-TXN', slug: 'SYNTHETIC-SLUG' });
                return new Response(JSON.stringify({ unhomologated: { paid: true } }), { status: 200 });
            } });
        await assert.rejects(adapters.checkClient.checkPayment({ apiKey: 'SYNTHETIC_ONLY', handle: 'synthetic',
            orderNsu: 'H1-TEST', transactionNsu: 'SYNTHETIC-TXN', invoiceSlug: 'SYNTHETIC-SLUG' }));
        assert.equal(calls, 1);
        assert.equal(Number((await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_PAYMENT_CHECK' }).count('* as n').first()).n), 1);
        assert.equal(Number((await db('outbox_eventos').count('* as n').first()).n), 0);
    });
    test('identical payment_check bodies with distinct HTTP status remain separate contract observations', async () => {
        let calls = 0;
        const before = Number((await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_PAYMENT_CHECK' }).count('* as n').first()).n);
        const adapters = module.createH1ObservationAdapters({ db, captureKey, publicOrigin: origin, allowRealRequests: true,
            transport: async () => new Response('{}', { status: ++calls === 1 ? 200 : 400 }) });
        for (let i = 0; i < 2; i++) await assert.rejects(adapters.checkClient.checkPayment({ apiKey: 'SYNTHETIC_ONLY', handle: 'synthetic',
            orderNsu: 'H1-TEST', transactionNsu: 'SYNTHETIC-TXN', invoiceSlug: 'SYNTHETIC-SLUG' }));
        const rows = await db('pagamentos_eventos').where({ tipo_evento: 'H1_OBSERVACAO_PAYMENT_CHECK' });
        assert.equal(rows.length - before, 2);
        assert.deepEqual(rows.map(open).filter(item => item.body === '{}').map(item => item.status).sort(), [200, 400]);
    });
});
