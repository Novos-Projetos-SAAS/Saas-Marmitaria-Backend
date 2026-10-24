const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const ERROR_CODES = new Set([
    'INFINITEPAY_CHECK_INVALID_INPUT',
    'INFINITEPAY_CHECK_NOT_CONFIGURED',
    'INFINITEPAY_CHECK_FAILED',
    'INFINITEPAY_CHECK_TIMEOUT'
]);
const FINANCIAL_STATES = new Set(['PAGA', 'LIQUIDADA', 'ESTORNADA']);
const IDENTIFIERS = { orderNsu: 120, transactionNsu: 255, invoiceSlug: 255 };

export class InfinitepayCheckError extends Error {
    constructor(code = 'INFINITEPAY_CHECK_FAILED') {
        super('Não foi possível verificar o pagamento.');
        this.name = 'InfinitepayCheckError';
        this.code = ERROR_CODES.has(code) ? code : 'INFINITEPAY_CHECK_FAILED';
    }
}

function invalid() {
    return new InfinitepayCheckError('INFINITEPAY_CHECK_INVALID_INPUT');
}

function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value;
}

function identifier(value, limit) {
    if (typeof value !== 'string' || !value.trim() || CONTROL_CHARACTERS.test(value)) throw invalid();
    const normalized = value.trim();
    if (normalized.length > limit) throw invalid();
    return normalized;
}

function httpsUrl(value) {
    if (typeof value !== 'string' || value !== value.trim() || CONTROL_CHARACTERS.test(value) ||
        !/^https:\/\//i.test(value) || value.includes('\\') || value.includes('#')) throw invalid();
    const url = new URL(value);
    const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || authority.includes('@')) throw invalid();
    return url;
}

export function normalizedPayment(parsed, expected, allowedOrigins) {
    record(parsed);
    const { paid, amount, paidAmount, installments, captureMethod, financialState, receiptUrl, identifiers } = parsed;
    if (typeof paid !== 'boolean') throw invalid();
    const payment = { paid };
    for (const [field, value, valid] of [
        ['amount', amount, Number.isSafeInteger(amount) && amount > 0],
        ['paidAmount', paidAmount, Number.isSafeInteger(paidAmount) && paidAmount >= 0],
        ['installments', installments, Number.isInteger(installments) && installments >= 1 && installments <= 32767],
        ['captureMethod', captureMethod, captureMethod === 'pix' || captureMethod === 'credit_card']
    ]) {
        if (paid || value !== undefined) {
            if (!valid) throw invalid();
            payment[field] = value;
        }
    }
    // Additional states must come from the explicit independent adapter, never a webhook.
    if (financialState !== undefined) {
        if (!FINANCIAL_STATES.has(financialState)) throw invalid();
        payment.financialState = financialState;
    }
    if (identifiers !== undefined) {
        record(identifiers);
        payment.identifiers = {};
        for (const [field, limit] of Object.entries(IDENTIFIERS)) {
            const value = identifier(identifiers[field], limit);
            if (value !== expected[field]) throw invalid();
            payment.identifiers[field] = value;
        }
    }
    if (receiptUrl !== undefined) {
        if (!paid) throw invalid();
        const url = httpsUrl(receiptUrl);
        if (!allowedOrigins.has(url.origin)) throw invalid();
        payment.receiptUrl = url.href;
    }
    return payment;
}

export function createInfinitepayCheckClient(configuration = {}) {
    let transport, parsePaymentCheck, receiptOrigins, timeoutMs;
    try {
        ({ transport, parsePaymentCheck, receiptOrigins = [], timeoutMs = 5000 } = record(configuration));
    } catch {
        throw new InfinitepayCheckError('INFINITEPAY_CHECK_NOT_CONFIGURED');
    }
    return {
        async checkPayment(request) {
            let apiKey, expected, body, allowedOrigins;
            let preflightCode = 'INFINITEPAY_CHECK_NOT_CONFIGURED';
            try {
                // No default transport or unhomologated provider response parser.
                if (typeof transport !== 'function' || typeof parsePaymentCheck !== 'function' ||
                    !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
                    !Array.isArray(receiptOrigins)) throw invalid();
                allowedOrigins = new Set(Array.from(receiptOrigins, origin => {
                    if (httpsUrl(origin).origin !== origin) throw invalid();
                    return origin;
                }));
                preflightCode = 'INFINITEPAY_CHECK_INVALID_INPUT';
                record(request);
                apiKey = request.apiKey;
                if (typeof apiKey !== 'string' || !/^[\x21-\x7E]+$/.test(apiKey)) throw invalid();
                const handle = identifier(request.handle, 150);
                expected = {};
                for (const [field, limit] of Object.entries(IDENTIFIERS)) expected[field] = identifier(request[field], limit);
                body = JSON.stringify({ handle, order_nsu: expected.orderNsu, transaction_nsu: expected.transactionNsu, slug: expected.invoiceSlug });
            } catch {
                throw new InfinitepayCheckError(preflightCode);
            }

            const controller = new AbortController();
            let timer;
            let timedOut = false;
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(new InfinitepayCheckError('INFINITEPAY_CHECK_TIMEOUT'));
                    controller.abort();
                }, timeoutMs);
            });
            try {
                const operation = (async () => {
                    const result = await transport('https://api.checkout.infinitepay.io/payment_check', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
                        body,
                        signal: controller.signal,
                        redirect: 'error'
                    });
                    if (controller.signal.aborted || !result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw invalid();
                    const data = await result.json();
                    if (controller.signal.aborted) throw invalid();
                    const parsed = await parsePaymentCheck(data);
                    if (controller.signal.aborted) throw invalid();
                    return normalizedPayment(parsed, expected, allowedOrigins);
                })();
                // Bound headers, JSON and adapter even when the injected transport ignores abort.
                return await Promise.race([operation, deadline]);
            } catch {
                throw new InfinitepayCheckError(timedOut ? 'INFINITEPAY_CHECK_TIMEOUT' : 'INFINITEPAY_CHECK_FAILED');
            } finally {
                clearTimeout(timer);
            }
        }
    };
}
