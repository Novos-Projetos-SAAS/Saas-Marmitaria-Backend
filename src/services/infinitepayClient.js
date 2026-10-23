const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ERROR_CODES = new Set([
    'INFINITEPAY_INVALID_INPUT',
    'INFINITEPAY_NOT_CONFIGURED',
    'INFINITEPAY_REQUEST_UNCERTAIN',
    'INFINITEPAY_TIMEOUT'
]);
const SAO_PAULO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export class InfinitepayClientError extends Error {
    constructor(code = 'INFINITEPAY_INVALID_INPUT', outcome = 'FALHOU') {
        super('Não foi possível criar o checkout.');
        this.name = 'InfinitepayClientError';
        this.code = ERROR_CODES.has(code) ? code : 'INFINITEPAY_INVALID_INPUT';
        this.outcome = outcome === 'INCERTA' ? 'INCERTA' : 'FALHOU';
    }
}

function invalidInput() {
    return new InfinitepayClientError('INFINITEPAY_INVALID_INPUT');
}

function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidInput();
    return value;
}

function text(value) {
    if (typeof value !== 'string' || !value.trim() || CONTROL_CHARACTERS.test(value)) throw invalidInput();
    return value.trim();
}

function httpsUrl(value) {
    if (typeof value !== 'string' || value !== value.trim() || CONTROL_CHARACTERS.test(value) ||
        !/^https:\/\//i.test(value) || value.includes('\\') || value.includes('#')) throw invalidInput();
    const url = new URL(value);
    const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || authority.includes('@')) throw invalidInput();
    return url;
}

function zonedParts(date) {
    return Object.fromEntries(SAO_PAULO.formatToParts(date)
        .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function utcTimestamp({ year, month, day, hour, minute, second }) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    return date.getTime();
}

export function checkoutValidUntil(now) {
    try {
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw invalidInput();
        const localDay = zonedParts(now);
        const wallClockEnd = utcTimestamp({ ...localDay, hour: 23, minute: 59, second: 59 });
        let instant = wallClockEnd;
        // Resolve the IANA offset at the target time, including historical DST.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const offset = utcTimestamp(zonedParts(new Date(instant))) - instant;
            const next = wallClockEnd - offset;
            if (next === instant) break;
            instant = next;
        }
        const resolved = zonedParts(new Date(instant));
        if (resolved.year !== localDay.year || resolved.month !== localDay.month || resolved.day !== localDay.day ||
            resolved.hour !== 23 || resolved.minute !== 59 || resolved.second !== 59 || instant <= now.getTime()) throw invalidInput();
        return new Date(instant).toISOString();
    } catch {
        throw invalidInput();
    }
}

function checkoutItems(items) {
    if (!Array.isArray(items) || items.length === 0) throw invalidInput();
    let total = 0;
    return Array.from(items, item => {
        record(item);
        const { quantity, price } = item;
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(price) || price <= 0) throw invalidInput();
        const lineTotal = quantity * price;
        total += lineTotal;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(total)) throw invalidInput();
        return { quantity, price, description: text(item.description) };
    });
}

function checkoutCustomer(customer) {
    if (customer === undefined) return undefined;
    record(customer);
    const allowed = {};
    for (const key of ['name', 'email', 'phone_number']) {
        if (!Object.hasOwn(customer, key)) continue;
        const value = text(customer[key]);
        if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalidInput();
        if (key === 'phone_number' && !/^\+[1-9]\d{7,14}$/.test(value)) throw invalidInput();
        allowed[key] = value;
    }
    return Object.keys(allowed).length ? allowed : undefined;
}

export function buildCheckoutPayload(input) {
    try {
        record(input);
        const {
            orderNsu, items, validUntil, redirectUrl, webhookUrl,
            assuredInstallments = 1, customer, now = new Date()
        } = input;
        const expiry = checkoutValidUntil(now);
        if (typeof validUntil !== 'string' || !ISO_INSTANT.test(validUntil) || Date.parse(validUntil) !== Date.parse(expiry)) throw invalidInput();
        if (!Number.isInteger(assuredInstallments) || assuredInstallments < 0 || assuredInstallments > 12) throw invalidInput();
        const payload = {
            order_nsu: text(orderNsu),
            items: checkoutItems(items),
            redirect_url: httpsUrl(redirectUrl).href,
            options: {
                assured_installments: assuredInstallments,
                require_delivery_address: false,
                single_payment: true,
                valid_until: expiry,
                payment_methods_enabled: ['pix', 'credit_card']
            },
            webhook: {
                url: httpsUrl(webhookUrl).href,
                events: ['created', 'paid', 'settled', 'payment_failed', 'canceled', 'refunded']
            }
        };
        const buyer = checkoutCustomer(customer);
        if (buyer) payload.customer = buyer;
        return payload;
    } catch {
        throw invalidInput();
    }
}

export function createInfinitepayClient(configuration = {}) {
    let transport, parseCreatedLink, checkoutOrigins, timeoutMs, now;
    try {
        ({ transport, parseCreatedLink, checkoutOrigins = [], timeoutMs = 5000, now = () => new Date() } = record(configuration));
    } catch {
        throw new InfinitepayClientError('INFINITEPAY_NOT_CONFIGURED');
    }
    return {
        async createCheckout(request) {
            let apiKey;
            let body;
            let allowedOrigins;
            let preflightCode = 'INFINITEPAY_NOT_CONFIGURED';
            try {
                // No network implementation or response contract is assumed here.
                if (typeof transport !== 'function' || typeof parseCreatedLink !== 'function' || typeof now !== 'function' ||
                    !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
                    !Array.isArray(checkoutOrigins) || checkoutOrigins.length === 0) throw invalidInput();
                allowedOrigins = new Set(Array.from(checkoutOrigins, origin => {
                    if (httpsUrl(origin).origin !== origin) throw invalidInput();
                    return origin;
                }));
                preflightCode = 'INFINITEPAY_INVALID_INPUT';
                record(request);
                apiKey = text(request.apiKey);
                if (apiKey !== request.apiKey || !/^[\x21-\x7E]+$/.test(apiKey)) throw invalidInput();
                const payload = record(request.payload);
                const options = record(payload.options);
                const webhook = record(payload.webhook);
                const validated = buildCheckoutPayload({
                    orderNsu: payload.order_nsu,
                    items: payload.items,
                    validUntil: options.valid_until,
                    redirectUrl: payload.redirect_url,
                    webhookUrl: webhook.url,
                    assuredInstallments: options.assured_installments,
                    customer: payload.customer,
                    now: now()
                });
                body = JSON.stringify(validated);
                // Check the clock again after building/serializing, directly before sending.
                if (checkoutValidUntil(now()) !== validated.options.valid_until) throw invalidInput();
            } catch {
                throw new InfinitepayClientError(preflightCode);
            }

            const controller = new AbortController();
            let timer;
            let timedOut = false;
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(new InfinitepayClientError('INFINITEPAY_TIMEOUT', 'INCERTA'));
                    controller.abort();
                }, timeoutMs);
            });
            try {
                const operation = (async () => {
                    const result = await transport('https://api.checkout.infinitepay.io/links', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
                        body,
                        signal: controller.signal,
                        redirect: 'error'
                    });
                    if (controller.signal.aborted || !result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw invalidInput();
                    const data = await result.json();
                    if (controller.signal.aborted) throw invalidInput();
                    const parsed = record(await parseCreatedLink(data));
                    if (controller.signal.aborted) throw invalidInput();
                    const url = httpsUrl(parsed.checkoutUrl);
                    if (!allowedOrigins.has(url.origin)) throw invalidInput();
                    const checkout = { checkoutUrl: url.href };
                    if (parsed.invoiceSlug !== undefined) checkout.invoiceSlug = text(parsed.invoiceSlug);
                    return checkout;
                })();
                // The race covers headers AND body, even if the injected transport ignores abort.
                return await Promise.race([operation, deadline]);
            } catch {
                // Once invoked, transport failures cannot prove whether a link was created.
                throw new InfinitepayClientError(timedOut ? 'INFINITEPAY_TIMEOUT' : 'INFINITEPAY_REQUEST_UNCERTAIN', 'INCERTA');
            } finally {
                clearTimeout(timer);
            }
        }
    };
}
