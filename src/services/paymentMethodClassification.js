// No automatic call or environment-driven map. Operator must first inspect real IDs,
// approve an explicit identity map, then run it in the separately authorized migration window.
export async function applyVerifiedPaymentMethodMap(db, map) {
    const types = new Set(['PIX','CREDITO','DEBITO','DINHEIRO','OUTRO']);
    if (!Array.isArray(map) || map.length === 0 || map.some(row =>
        !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.nome_esperado !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.codigo || '') || !types.has(row.tipo_financeiro)) ||
        new Set(map.map(row => row.id)).size !== map.length ||
        new Set(map.map(row => row.codigo)).size !== map.length) throw new Error('Mapa explícito inválido.');
    return db.transaction(async trx => {
        const rows = await trx('metodos_pagamento').whereIn('id',map.map(row => row.id)).orderBy('id').forUpdate();
        for (const item of map) {
            const row = rows.find(row => row.id === item.id);
            if (!row || row.nome !== item.nome_esperado ||
                (row.codigo !== null && (row.codigo !== item.codigo || row.tipo_financeiro !== item.tipo_financeiro))) {
                throw new Error('Mapa não corresponde ao cadastro revisado; nenhuma classificação aplicada.');
            }
        }
        for (const item of map) await trx('metodos_pagamento').where({ id: item.id }).update({ codigo: item.codigo, tipo_financeiro: item.tipo_financeiro });
        return map.map(({ id, codigo, tipo_financeiro }) => ({ id, codigo, tipo_financeiro }));
    });
}
