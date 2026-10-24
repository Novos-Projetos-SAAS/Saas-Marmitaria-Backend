import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObservedInfinitepayEvent } from '../../src/services/infinitepayObservedContracts.js';

const base = { order_nsu: 'SYNTHETIC_ORDER', invoice_slug: 'SYNTHETIC_INVOICE' };
for (const type of ['created', 'paid', 'settled']) test('observed ' + type + ' maps identifiers without manufacturing transaction, receipt or financial proof', () => {
    assert.deepEqual(parseObservedInfinitepayEvent({ ...base, event_type: type, paid: true, amount: 100,
        receipt_url: 'https://untrusted.invalid/SYNTHETIC' }), { type, orderNsu: base.order_nsu, invoiceSlug: base.invoice_slug });
});
test('the observed slug alias is supported, but conflicting aliases are rejected', () => {
    assert.deepEqual(parseObservedInfinitepayEvent({ event_type: 'paid', order_nsu: base.order_nsu, slug: base.invoice_slug, transaction_nsu: 'SYNTHETIC_TX' }),
        { type: 'paid', orderNsu: base.order_nsu, invoiceSlug: base.invoice_slug, transactionNsu: 'SYNTHETIC_TX' });
    assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', slug: 'OTHER' }));
});
test('a present null invoice identifier cannot be replaced silently by the alias', () => {
    assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', invoice_slug: null, slug: base.invoice_slug }));
});
for (const field of ['order_nsu', 'invoice_slug', 'transaction_nsu']) test('null, blank and control characters are rejected in ' + field, () => {
    for (const value of [null, '', '   ', ' x', 'x\u200b', 'x\n']) {
        assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type: 'paid', [field]: value }));
    }
});
test('unobserved lifecycle event contracts are blocked instead of guessed', () => {
    for (const event_type of ['refunded', 'canceled', 'payment_failed', 'unknown', null]) {
        assert.throws(() => parseObservedInfinitepayEvent({ ...base, event_type }));
    }
});
