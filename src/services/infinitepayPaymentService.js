
import { createHash, randomUUID } from 'node:crypto';
import connection from '../database/connection.js';
import { buscarPedidoCompletoPorId } from '../utils/pedidosUtils.js';
import { getInfinitepayConfig, getPaymentCredential } from './infinitepayConfigService.js';

const API = 'https://api.checkout.infinitepay.io';
const PAID = ['PAGA', 'LIQUIDADA'];

export function paymentError(message, statusCode = 409) {
    return Object.assign(new Error(message), { statusCode });
}

export function checkoutTokenHash(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
        throw paymentError('Identificador de checkout inválido.', 400);
    }
    return createHash('sha256').update(value.toLowerCase()).digest('hex');
}

function identifier(value, name, max = 255) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\s\x00-\x1f\x7f]/.test(value)) {
        throw paymentError(`Informe ${name} válido.`, 400);
    }
    return value;
}

function publicOrigins() {
    const backend = new URL(process.env.RENDER_EXTERNAL_URL || '');
    const frontend = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean)
        .map(v => new URL(v)).find(url => url.protocol === 'https:');

    if (backend.protocol !== 'https:' || backend.username || backend.password || !frontend || frontend.username || frontend.password) {
        throw paymentError('A hospedagem deve informar sua URL pública HTTPS e a origem HTTPS do frontend.', 503);
    }

    return {
        webhook: new URL('/pagamentos/webhook/infinitepay', backend.origin).href,
        redirect: new URL('/pedido/sucesso', frontend.origin).href
    };
}

export function infinitepayMethod(metodo) {
    const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
        .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

    const nome = normalize(metodo.nome);
    const codigo = normalize(metodo.codigo);

    if (/\b(ENTREGA|PRESENCIAL|BALCAO|RETIRADA)\b/.test(`${nome} ${codigo}`)) return null;
    if (metodo.tipo_financeiro === 'PIX' || codigo === 'PIX') return 'pix';
    if (metodo.tipo_financeiro === 'CREDITO' || codigo === 'CARTAO CREDITO') return 'credit_card';
    if (metodo.tipo_financeiro && metodo.tipo_financeiro !== 'OUTRO') return null;
    if (nome === 'PIX') return 'pix';
    if (nome === 'CARTAO DE CREDITO' || nome === 'CARTAO CREDITO' || nome === 'CREDITO') return 'credit_card';

    return null;
}

async function requireOnlineConfiguration(db, config) {
    if (config?.ativo !== true || !config.credencial_atual_id || !config.handle) {
        throw paymentError('Configuração de checkout InfinitePay indisponível.', 503);
    }

    const credential = await getPaymentCredential(config.credencial_atual_id, db);

    if (credential.handle !== config.handle) {
        throw paymentError('A credencial InfinitePay não corresponde à conta configurada.', 503);
    }

    try {
        return publicOrigins();
    } catch (error) {
        if (error.statusCode) throw error;
        throw paymentError('URL pública HTTPS da hospedagem indisponível.', 503);
    }
}

export async function prepareOnlinePayment(pedido, valorCentavos, db, config, method, items) {
    const { webhook, redirect } = await requireOnlineConfiguration(db, config);

    if (!Number.isSafeInteger(valorCentavos) || valorCentavos < 100) {
        throw paymentError('O pagamento online deve ser de pelo menos R$ 1,00.', 400);
    }

    const invalidItems = !Array.isArray(items) || !items.length || items.some(item =>
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isSafeInteger(item.price) || item.price <= 0 ||
        typeof item.description !== 'string' || !item.description.trim()
    );

    const totalItems = invalidItems ? NaN : items.reduce((sum, item) => sum + item.quantity * item.price, 0);

    if (invalidItems || !Number.isSafeInteger(totalItems) || totalItems !== valorCentavos) {
        throw paymentError('Itens do checkout inválidos ou divergentes do total do pedido.', 400);
    }

    const orderNsu = `pedido-${pedido.id}-${randomUUID()}`;
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const payload = {
        handle: config.handle,
        order_nsu: orderNsu,
        items: items.map(({ description, quantity, price }) => ({ description, quantity, price })),
        customer: { name: String(pedido.nome_cliente).trim(), phone_number: `+55${pedido.telefone_cliente}` },
        webhook_url: webhook,
        redirect_url: redirect,
        options: {
            assured_installments: config.assured_installments,
            single_payment: true,
            payment_methods_enabled: method === 'pix' ? ['pix', 'credit_card'] : ['credit_card'],
            require_delivery_address: false,
            valid_until: validUntil
        }
    };

    await db('pagamentos').insert({
        pedido_id: pedido.id, tentativa_numero: 1, order_nsu: orderNsu,
        status: 'AGUARDANDO', valor_centavos: valorCentavos, credencial_id: config.credencial_atual_id,
        handle_snapshot: config.handle, valid_until: validUntil, checkout_payload: payload
    });
}

async function providerRequest(endpoint, apiKey, body) {
    let response;

    try {
        response = await fetch(`${API}/${endpoint}`, {
            method: 'POST',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000)
        });
    } catch {
        throw paymentError('A InfinitePay não respondeu. A cobrança permanece aguardando conciliação.', 503);
    }

    if (!response.ok) {
        throw paymentError('Não foi possível concluir a solicitação na InfinitePay. Confira a configuração e concilie o pedido.', 502);
    }

    try {
        return await response.json();
    } catch {
        throw paymentError('Resposta inválida da InfinitePay. Aguarde a conciliação do pedido.', 502);
    }
}

function trustedProviderUrl(value, kind) {
    if (typeof value !== 'string' || !value) return null;

    try {
        const url = new URL(value);
        const hosts = kind === 'checkout'
            ? ['checkout.infinitepay.io', 'buy.infinitepay.io']
            : ['recibo.infinitepay.io', 'comprovante.infinitepay.io'];

        if (url.protocol !== 'https:' || !hosts.includes(url.hostname) ||
            url.port || url.username || url.password || /[\x00-\x20\\]/.test(value)) return null;

        return url.href;
    } catch {
        return null;
    }
}

// Aceita o recibo somente quando os identificadores correspondem à cobrança.
function receiptFromCallback(payment, supplied = {}) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return null;
    if (supplied.order_nsu !== payment.order_nsu) return null;
    if (!payment.transaction_nsu || supplied.transaction_nsu !== payment.transaction_nsu) return null;
    if (!payment.invoice_slug) return null;
    if (supplied.slug !== undefined && supplied.invoice_slug !== undefined && supplied.slug !== supplied.invoice_slug) return null;
    if ((supplied.invoice_slug || supplied.slug) !== payment.invoice_slug) return null;

    return trustedProviderUrl(supplied.receipt_url, 'receipt');
}

export function paymentStatus(status) {
    if (PAID.includes(status)) return 'PAGO';
    if (['CANCELADA', 'EXPIRADA', 'ESTORNADA'].includes(status)) return 'CANCELADO';
    if (['FALHOU', 'DIVERGENTE'].includes(status)) return 'FALHOU';
    return 'PENDENTE';
}

function paymentDto(row) {
    return {
        pedido_id: row.pedido_id,
        order_nsu: row.order_nsu,
        checkout_url: row.status === 'Cancelado' || paymentStatus(row.pagamento_status) !== 'PENDENTE' ? null : row.checkout_url,
        pagamento_status: paymentStatus(row.pagamento_status),
        valor_total: Number(row.valor_total),
        status: row.status, nome_cliente: row.nome_cliente, criado_em: row.criado_em,
        transaction_nsu: row.transaction_nsu, invoice_slug: row.invoice_slug,
        metodo_pagamento_nome: row.capture_method === 'pix' ? 'Pix (InfinitePay)' : row.capture_method === 'credit_card' ? 'Cartão (InfinitePay)' : 'InfinitePay',
        receipt_url: trustedProviderUrl(row.receipt_url, 'receipt'),
        ...(row.error_code === 'CHECKOUT_INCERTO' ? {
            checkout_error: 'A geração do link não foi concluída. O pedido foi salvo e aguarda conciliação pela loja.'
        } : {})
    };
}

function paymentQuery() {
    return connection('pagamentos as pg')
        .join('pedidos as p', 'p.id', 'pg.pedido_id')
        .select(
            'pg.id as pagamento_id', 'pg.pedido_id', 'pg.order_nsu', 'pg.checkout_url',
            'pg.status as pagamento_status', 'pg.transaction_nsu', 'pg.invoice_slug',
            'pg.capture_method', 'pg.receipt_url', 'pg.error_code',
            'p.valor_total', 'p.status', 'p.nome_cliente', 'p.criado_em'
        )
        .where('pg.provedor', 'INFINITEPAY');
}

export async function ownedPayment(pedidoId, token) {
    const tokenHash = checkoutTokenHash(token);

    const row = await paymentQuery()
        .where('p.id', pedidoId)
        .where('p.checkout_token_hash', tokenHash)
        .orderBy('pg.tentativa_numero', 'desc')
        .first();

    if (!row) throw paymentError('Pedido não encontrado.', 404);
    return paymentDto(row);
}

export async function checkoutForOrder(pedidoId, { recover = false } = {}) {
    const claimed = await connection.transaction(async db => {
        const pedido = await db('pedidos').where({ id: pedidoId }).forUpdate().first();
        const payment = await db('pagamentos').where({ pedido_id: pedidoId }).orderBy('tentativa_numero', 'desc').forUpdate().first();

        if (!payment || !pedido || pedido.fluxo_pagamento !== 'INFINITEPAY') {
            throw paymentError('Cobrança não encontrada.', 404);
        }

        if (payment.checkout_url) return null;

        const stalled = payment.status === 'CRIANDO' &&
            Date.now() - new Date(payment.atualizado_em).getTime() > 30000;

        if (payment.status !== 'AGUARDANDO' && !(recover && (payment.status === 'INCERTA' || stalled))) return null;
        if (pedido.status === 'Cancelado' || pedido.deletado_em || !payment.checkout_payload) return null;

        const config = await getInfinitepayConfig(db, { lock: true });
        if (config.ativo !== true) return null;

        if (new Date(payment.valid_until).getTime() <= Date.now()) {
            throw paymentError('O checkout expirou. Confira a cobrança na InfinitePay antes de criar outro pedido.');
        }

        await db('pagamentos').where({ id: payment.id })
            .update({ status: 'CRIANDO', atualizado_em: db.fn.now() });

        return payment;
    });

    if (claimed) {
        try {
            const credential = await getPaymentCredential(claimed.credencial_id);
            const result = await providerRequest('links', credential.apiKey, claimed.checkout_payload);
            const url = trustedProviderUrl(result?.url, 'checkout');

            if (!url) throw paymentError('Destino de checkout inválido.', 502);

            await connection('pagamentos')
                .where({ id: claimed.id })
                .whereIn('status', ['CRIANDO', 'AGUARDANDO'])
                .update({ checkout_url: url, status: 'AGUARDANDO', error_code: null, atualizado_em: connection.fn.now() });
        } catch {
            await connection('pagamentos')
                .where({ id: claimed.id, status: 'CRIANDO' })
                .update({ status: 'INCERTA', error_code: 'CHECKOUT_INCERTO', atualizado_em: connection.fn.now() });
        }
    }

    const row = await paymentQuery().where('p.id', pedidoId)
        .orderBy('pg.tentativa_numero', 'desc').first();

    return paymentDto(row);
}

export async function confirmPayment(orderNsu, supplied = {}) {
    identifier(orderNsu, 'order_nsu', 120);

    const current = await connection('pagamentos').where({ order_nsu: orderNsu }).first();
    if (!current) throw paymentError('Cobrança não encontrada.', 404);

    // Um webhook posterior pode preencher o recibo de um pagamento confirmado.
    if (PAID.includes(current.status)) {
        const receiptUrl = current.provider_verified_at
            ? receiptFromCallback(current, supplied)
            : null;

        if (!current.receipt_url && receiptUrl) {
            await connection('pagamentos')
                .where({ id: current.id, transaction_nsu: current.transaction_nsu, invoice_slug: current.invoice_slug })
                .whereIn('status', PAID)
                .whereNotNull('provider_verified_at')
                .whereNull('receipt_url')
                .update({ receipt_url: receiptUrl, atualizado_em: connection.fn.now() });
        }
        return;
    }

    if (current.status === 'ESTORNADA') return;

    const transactionNsu = identifier(supplied.transaction_nsu || current.transaction_nsu, 'transaction_nsu');
    const slug = identifier(supplied.invoice_slug || supplied.slug || current.invoice_slug, 'slug');

    await connection('pagamentos').where({ id: current.id })
        .whereNotIn('status', [...PAID, 'ESTORNADA'])
        .update({ transaction_nsu: transactionNsu, invoice_slug: slug, last_checked_at: connection.fn.now() });

    const credential = await getPaymentCredential(current.credencial_id);

    const verified = await providerRequest('payment_check', credential.apiKey, {
        handle: current.handle_snapshot || credential.handle,
        order_nsu: current.order_nsu,
        transaction_nsu: transactionNsu,
        slug
    });

    if (verified?.success !== true || verified?.paid !== true) return;

    if (!Number.isSafeInteger(verified.amount) || verified.amount !== Number(current.valor_centavos)) {
        throw paymentError('O valor confirmado difere do pedido. É necessária conciliação administrativa.');
    }

    for (const [field, value] of [
        ['order_nsu', orderNsu],
        ['transaction_nsu', transactionNsu],
        ['slug', slug],
        ['invoice_slug', slug]
    ]) {
        if (verified[field] !== undefined && verified[field] !== value) {
            throw paymentError('Identificação financeira divergente.');
        }
    }

    if (!['pix', 'credit_card'].includes(verified.capture_method)) {
        throw paymentError('Método de pagamento não confirmado pela InfinitePay.');
    }

    // O link não confirma pagamento; a validação ocorreu no payment_check.
    const receiptUrl = trustedProviderUrl(verified.receipt_url, 'receipt') ||
        receiptFromCallback({
            order_nsu: orderNsu,
            transaction_nsu: transactionNsu,
            invoice_slug: slug
        }, supplied);

    const released = await connection.transaction(async db => {
        const pedido = await db('pedidos').where({ id: current.pedido_id }).forUpdate().first();
        const payment = await db('pagamentos').where({ id: current.id }).forUpdate().first();

        if (PAID.includes(payment.status)) {
            if (payment.provider_verified_at && !payment.receipt_url && receiptUrl &&
                payment.transaction_nsu === transactionNsu && payment.invoice_slug === slug) {
                await db('pagamentos')
                    .where({ id: payment.id })
                    .whereNull('receipt_url')
                    .whereIn('status', PAID)
                    .update({ receipt_url: receiptUrl, atualizado_em: db.fn.now() });
            }
            return false;
        }

        if (payment.status === 'ESTORNADA') return false;

        // Evita vincular a mesma transação a dois pedidos.
        await db.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`infinitepay:${transactionNsu}`]);

        const duplicate = await db('pagamentos')
            .where({ transaction_nsu: transactionNsu })
            .whereIn('status', [...PAID, 'ESTORNADA'])
            .whereNot('id', payment.id)
            .first('id');

        if (duplicate) throw paymentError('Transação já vinculada a outro pedido.');

        if (!pedido || Math.round(Number(pedido.valor_total) * 100) !== Number(payment.valor_centavos)) {
            throw paymentError('O valor do pedido mudou. É necessária conciliação administrativa.');
        }

        await db('pagamentos').where({ id: payment.id }).update({
            status: 'PAGA',
            transaction_nsu: transactionNsu, invoice_slug: slug,
            capture_method: verified.capture_method,
            installments: Number.isInteger(verified.installments) && verified.installments >= 1 && verified.installments <= 12
                ? verified.installments : null,
            valor_base_provider_centavos: verified.amount,
            valor_pago_provider_centavos: Number.isSafeInteger(verified.paid_amount) ? verified.paid_amount : null,
            receipt_url: receiptUrl,
            provider_verified_at: db.fn.now(),
            pago_em: db.fn.now(),
            last_checked_at: db.fn.now(),
            atualizado_em: db.fn.now(),
            error_code: null
        });

        if (pedido.status === 'Cancelado' || pedido.deletado_em || pedido.liberado_cozinha_em) return false;

        await db('pedidos').where({ id: pedido.id })
            .update({ liberado_cozinha_em: db.fn.now(), atualizado_em: db.fn.now() });

        return true;
    });

    if (released) {
        try {
            const pedido = await buscarPedidoCompletoPorId(current.pedido_id);
            global.io?.to('pedidos').emit('novo_pedido_recebido', pedido);
        } catch {
            console.error('Falha ao notificar a cozinha. O pedido confirmado permanece disponível na listagem.');
        }
    }
}

export async function adminPayments(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));

    const dates = ['data_inicio', 'data_fim'].map(key => {
        const value = query[key];
        if (value === undefined || value === '') return null;

        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
            throw paymentError('Informe um período válido.', 400);
        }
        return value;
    });

    const [start, end] = dates;
    if (start && end && start > end) throw paymentError('A data inicial deve ser anterior à data final.', 400);

    const ranked = paymentQuery()
        .leftJoin('metodos_pagamento as mp', 'mp.id', 'p.metodo_pagamento_id')
        .select(
            'pg.pago_em', 'pg.criado_em as pagamento_criado_em',
            'pg.valor_centavos', 'pg.capture_method',
            'mp.nome as metodo_selecionado_nome',
            connection.raw(`CASE WHEN pg.status IN ('PAGA', 'LIQUIDADA', 'ESTORNADA')
                THEN pg.pago_em ELSE pg.criado_em END AS data_transacao`),
            connection.raw(`ROW_NUMBER() OVER (
                PARTITION BY pg.handle_snapshot, COALESCE(NULLIF(pg.transaction_nsu, ''), pg.order_nsu)
                ORDER BY pg.atualizado_em DESC, pg.id DESC) AS ordem_transacao`)
        );

    const filtered = connection(ranked.as('transacoes'))
        .select('*')
        .where('ordem_transacao', 1);

    if (start) {
        filtered.whereRaw("data_transacao >= (?::date::timestamp AT TIME ZONE 'America/Sao_Paulo')", [start]);
    }
    if (end) {
        filtered.whereRaw("data_transacao < ((?::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')", [end]);
    }

    const rows = await connection(filtered.as('periodo'))
        .select(
            '*',
            connection.raw(`SUM(CASE WHEN pagamento_status IN ('PAGA', 'LIQUIDADA') AND pago_em IS NOT NULL
                THEN valor_centavos ELSE 0 END) OVER (
                PARTITION BY (data_transacao AT TIME ZONE 'America/Sao_Paulo')::date
                ) AS total_dia_centavos`),
            connection.raw('COUNT(*) OVER () AS total_registros')
        )
        .orderBy('data_transacao', 'desc', 'last')
        .orderBy('pagamento_id', 'desc')
        .limit(limit)
        .offset((page - 1) * limit);

    return rows.map(row => ({
        ...paymentDto(row),
        pagamento_id: row.pagamento_id,
        status_financeiro: row.pagamento_status,
        pago_em: row.pago_em,
        pagamento_criado_em: row.pagamento_criado_em,
        data_transacao: row.data_transacao,
        capture_method: row.capture_method,
        metodo_pagamento_nome: row.capture_method ? paymentDto(row).metodo_pagamento_nome : row.metodo_selecionado_nome,
        valor_centavos: Number(row.valor_centavos),
        total_dia_centavos: Number(row.total_dia_centavos),
        total_registros: Number(row.total_registros)
    }));
}

export async function reconcileOrder(pedidoId, supplied) {
    const payment = await connection('pagamentos')
        .where({ pedido_id: pedidoId })
        .orderBy('tentativa_numero', 'desc')
        .first();

    if (!payment) throw paymentError('Cobrança não encontrada.', 404);

    if (!payment.checkout_url && payment.checkout_payload && !payment.transaction_nsu && !supplied.transaction_nsu) {
        return checkoutForOrder(pedidoId, { recover: true });
    }

    await confirmPayment(payment.order_nsu, supplied);

    const row = await paymentQuery().where('pg.id', payment.id).first();
    return paymentDto(row);
}
