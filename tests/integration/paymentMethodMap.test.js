import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { applyVerifiedPaymentMethodMap } from '../../src/services/paymentMethodClassification.js';
test('explicit synthetic ID map validates identity and is atomic, idempotent and immune to renamed labels', async () => {
    const f = await createTestDatabase();
    try {
        await f.db.migrate.latest();
        await f.db('metodos_pagamento').insert([{ id: 91, nome: 'Meio A' }, { id: 105, nome: 'Meio B' }]);
        const good = { id: 91, nome_esperado: 'Meio A', codigo: 'DINHEIRO', tipo_financeiro: 'DINHEIRO' };
        await assert.rejects(applyVerifiedPaymentMethodMap(f.db, [good, { id: 999, nome_esperado: 'Meio B', codigo: 'DEBITO', tipo_financeiro: 'DEBITO' }]));
        assert.equal((await f.db('metodos_pagamento').where({ id: 91 }).first()).codigo, null);
        await applyVerifiedPaymentMethodMap(f.db, [good]);
        assert.equal((await f.db('metodos_pagamento').where({ id: 91 }).first()).codigo, 'DINHEIRO');
        await applyVerifiedPaymentMethodMap(f.db, [good]);
        await assert.rejects(applyVerifiedPaymentMethodMap(f.db, [{ ...good, tipo_financeiro: 'PIX' }]));
        await f.db('metodos_pagamento').where({ id: 91 }).update({ nome: 'Nome editado' });
        assert.equal((await f.db('metodos_pagamento').where({ id: 91 }).first()).tipo_financeiro, 'DINHEIRO');
        assert.equal((await f.db('metodos_pagamento').where({ id: 105 }).first()).tipo_financeiro, 'OUTRO');
    } finally { await f.close(); }
});
