import { test } from 'node:test';
import assert from 'node:assert/strict';

const migrations = [
    '20261022000100_infinitepay_metodos_pedidos.js',
    '20261022000200_infinitepay_config_credenciais.js',
    '20261022000300_infinitepay_pagamentos_eventos_acessos_outbox.js',
    '20261022000400_infinitepay_permissoes.js',
    '20261023000100_classificar_metodos_pagamento_aprovados.js'
];
for (const name of migrations) {
    test(name + ' down rejects before any database interaction', async () => {
        const { down } = await import('../../src/database/migrations/' + name);
        const interactions = [];
        // The dependency is a tripwire, not a simulated database: ANY access is
        // forbidden by the forward-only contract, including reads and locks.
        const forbidden = operation => {
            interactions.push(operation);
            throw new Error('Unexpected database interaction before rollback refusal');
        };
        const db = new Proxy(() => {}, {
            apply: () => forbidden('query'),
            get: (_, key) => forbidden(String(key))
        });
        await assert.rejects(down(db), error => {
            assert.match(error.message, /Rollback bloqueado.*forward-only/i);
            assert.match(error.message, /dados.*estrutura/i);
            return true;
        });
        assert.deepEqual(interactions, []);
    });
}
