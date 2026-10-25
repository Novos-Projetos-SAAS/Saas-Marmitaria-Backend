export function parseObservedCreatedLink(data, { checkoutOrigins = ['https://checkout.infinitepay.io'] } = {}) {
    const value = data?.url;
    if (!data || Array.isArray(data) || typeof value !== 'string' || value.length > 8192 ||
        /[\s\p{C}\\]/u.test(value) || /%(?![a-f0-9]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
        !value.startsWith('https://')) throw new Error('Contrato de checkout inválido.');
    const url = new URL(value);
    if (!checkoutOrigins.includes(url.origin) || url.href !== value || url.username || url.password || url.hash) throw new Error('Destino de checkout inválido.');
    return { checkoutUrl: value };
}
export function parseObservedPaymentCheck(data, expected, { receiptOrigins = ['https://recibo.infinitepay.io'] } = {}) {
    if (!data || Array.isArray(data) || typeof data !== 'object' ||
        (Object.hasOwn(data, 'success') && data.success !== true)) throw new Error('Contrato de verificação inválido.');
    for (const [field,key] of [['order_nsu','orderNsu'],['transaction_nsu','transactionNsu'],['slug','invoiceSlug'],['invoice_slug','invoiceSlug']]) {
        if (Object.hasOwn(data,field) && data[field] !== expected[key]) throw new Error('Identificação financeira divergente.');
    }
    if (data.receipt_url !== undefined && !receiptMatchesTransaction(data.receipt_url,expected.transactionNsu,receiptOrigins)) throw new Error('Comprovante divergente.');
    return { paid:data.paid, amount:data.amount, paidAmount:data.paid_amount, installments:data.installments,
        captureMethod:data.capture_method, ...(data.receipt_url !== undefined ? { receiptUrl:data.receipt_url } : {}) };
}
export function receiptMatchesTransaction(value, transaction, origins = ['https://recibo.infinitepay.io']) {
    try {
        if (typeof value !== 'string' || /[\s\p{C}\\#]/u.test(value) || !value.startsWith('https://')) return false;
        const url=new URL(value);
        return origins.includes(url.origin) && url.href === value && !url.username && !url.password && decodeURIComponent(url.pathname) === '/'+transaction;
    } catch { return false; }
}

export function parseObservedInfinitepayEvent(raw, { receiptOrigins = ['https://recibo.infinitepay.io'] } = {}) {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' || !['created', 'paid', 'settled'].includes(raw.event_type)) {
        throw new Error('Contrato de evento InfinitePay não homologado.');
    }
    const identifier = (value, limit) => {
        if (typeof value !== 'string' || !value || value !== value.trim() || value.length > limit || /[\p{Cc}\p{Cf}]/u.test(value)) {
            throw new Error('Identificador do evento InfinitePay inválido.');
        }
        return value;
    };
    const invoiceSlug = identifier(Object.hasOwn(raw, 'invoice_slug') ? raw.invoice_slug : raw.slug, 255);
    if (raw.slug !== undefined && identifier(raw.slug, 255) !== invoiceSlug) throw new Error('Identificadores de fatura divergentes.');
    return { type: raw.event_type, orderNsu: identifier(raw.order_nsu, 120), invoiceSlug,
        ...(raw.transaction_nsu !== undefined ? { transactionNsu: identifier(raw.transaction_nsu, 255) } : {}),
        ...(receiptMatchesTransaction(raw.receipt_url,raw.transaction_nsu,receiptOrigins) ? { receiptUrl:raw.receipt_url } : {}) };
}
