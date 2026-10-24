export function parseObservedInfinitepayEvent(raw) {
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
        ...(raw.transaction_nsu !== undefined ? { transactionNsu: identifier(raw.transaction_nsu, 255) } : {}) };
}
