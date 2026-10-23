import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definirFluxoCriacao, rejeitarControleFinanceiro } from '../../src/utils/pedidoPaymentPolicy.js';

const pix = { id: 934, nome: 'Dinheiro renomeado', codigo: 'PIX', tipo_financeiro: 'PIX' };
const credito = { id: 721, nome: 'Nome personalizado', codigo: 'CREDITO', tipo_financeiro: 'CREDITO' };

for (const metodo of [pix, credito]) {
    test('public origin cannot bypass future online selection by claiming Presencial for ' + metodo.codigo, () => {
        assert.throws(() => definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado: true, configAtiva: true,
            tipo_pedido: 'Presencial', fluxo_pagamento: 'POSTERIOR' }), error => error.statusCode === 503);
        assert.equal(definirFluxoCriacao({ origem: 'ADMIN', metodo, habilitado: true, configAtiva: true,
            tipo_pedido: 'Remoto' }), 'POSTERIOR');
    });
    test('disabled flag or inactive configuration keeps ' + metodo.codigo + ' on the existing flow', () => {
        for (const [habilitado, configAtiva] of [[false, false], [false, true], [true, false]]) {
            assert.equal(definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado, configAtiva }), 'POSTERIOR');
        }
    });
}

for (const [codigo, nome] of [['DINHEIRO', 'Pix'], ['DEBITO', 'Cartão de Crédito'], ['OUTRO', 'PIX InfinitePay']]) {
    test('stable classification preserves posterior method ' + codigo + ' independently of its name', () => {
        assert.equal(definirFluxoCriacao({ origem: 'PUBLICO', metodo: { id: 802, nome, codigo, tipo_financeiro: codigo },
            habilitado: true, configAtiva: true }), 'POSTERIOR');
    });
}

test('unmapped and inconsistent methods never become gateway methods based on names or IDs', () => {
    for (const metodo of [{ id: 1, nome: 'Pix', codigo: null, tipo_financeiro: 'OUTRO' },
        { id: 3, nome: 'Crédito', codigo: 'CREDITO', tipo_financeiro: 'OUTRO' }]) {
        assert.equal(definirFluxoCriacao({ origem: 'PUBLICO', metodo, habilitado: true, configAtiva: true }), 'POSTERIOR');
    }
});

test('unknown route origin is rejected rather than being treated as an administrative order', () => {
    assert.throws(() => definirFluxoCriacao({ origem: 'ADMIN_FROM_BODY', metodo: pix }), error => error.statusCode === 400);
});

test('client financial control is rejected while legacy delivery and order type fields remain accepted', () => {
    assert.doesNotThrow(() => rejeitarControleFinanceiro({ tipo_pedido: 'Presencial', metodo_entrega: 'Retirada' }));
    for (const field of ['fluxo_pagamento', 'liberado_cozinha_em', 'provider_verified_at', 'pago_em',
        'status_pagamento', 'payment_status', 'bloqueia_nova_cobranca', 'pagamentos']) {
        assert.throws(() => rejeitarControleFinanceiro({ [field]: null }), error => error.statusCode === 400);
    }
});
