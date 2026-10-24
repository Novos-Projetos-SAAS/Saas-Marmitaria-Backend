const approvedMethods = [
    { id: 1, nome: 'Pix', codigo: 'PIX', tipo_financeiro: 'PIX' },
    { id: 2, nome: 'Dinheiro', codigo: 'DINHEIRO', tipo_financeiro: 'DINHEIRO' },
    { id: 3, nome: 'Cartão de Crédito', codigo: 'CARTAO_CREDITO', tipo_financeiro: 'CREDITO' },
    { id: 4, nome: 'Cartão de Débito', codigo: 'CARTAO_DEBITO', tipo_financeiro: 'DEBITO' }
];

export async function up(knex) {
    return knex.transaction(async trx => {
        // Keep reviewed identities and code ownership stable until every update commits.
        await trx.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', ['metodos_pagamento']);
        const rows = await trx('metodos_pagamento').select('id', 'nome', 'ativo', 'deletado_em', 'codigo', 'tipo_financeiro').orderBy('id');
        // Fresh installations have no records to backfill; this migration never creates methods.
        if (rows.length === 0) return;
        for (const expected of approvedMethods) {
            const row = rows.find(item => item.id === expected.id);
            if (!row || row.nome !== expected.nome || row.ativo !== true || row.deletado_em !== null) {
                throw new Error('Backfill bloqueado: cadastro divergente do mapeamento aprovado (ID ' + expected.id + ').');
            }
            if ((row.codigo !== null && row.codigo !== expected.codigo) ||
                !['OUTRO', expected.tipo_financeiro].includes(row.tipo_financeiro)) {
                throw new Error('Backfill bloqueado: classificação existente conflitante (ID ' + expected.id + ').');
            }
        }
        const ids = new Set(approvedMethods.map(row => row.id));
        const codes = new Set(approvedMethods.map(row => row.codigo));
        if (rows.some(row => !ids.has(row.id) && codes.has(row.codigo))) {
            throw new Error('Backfill bloqueado: código aprovado pertence a método não incluído no mapeamento.');
        }
        for (const expected of approvedMethods) {
            const row = rows.find(item => item.id === expected.id);
            if (row.codigo !== expected.codigo || row.tipo_financeiro !== expected.tipo_financeiro) {
                await trx('metodos_pagamento').where({ id: expected.id }).update({ codigo: expected.codigo, tipo_financeiro: expected.tipo_financeiro });
            }
        }
    });
}

export async function down() {
    throw new Error('Rollback bloqueado (forward-only): os dados e a estrutura existentes devem ser preservados. Use uma migration aditiva de correção.');
}
