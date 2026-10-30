/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
export async function seed(knex) {

    // Esta seed apaga cadastros. Nunca execute em ambiente financeiro real.
    if(process.env.NODE_ENV==='production' || process.env.INFINITEPAY_MODE==='production') {
        throw new Error('Seed inicial destrutiva bloqueada em produção. Use a seed 14 específica da InfinitePay.');
    }

    // 🧹 Tabelas seguras para limpar
    await knex('metodos_pagamento').del();
    await knex('tamanhos_marmitas').del();
    await knex('categorias_alimentos').del();

    // 🔒 NÃO deletar niveis_acesso (tem FK com usuarios)

    // 🔐 NÍVEIS DE ACESSO (idempotente)
    await knex('niveis_acesso')
        .insert([
            { id: 1, nome: 'admin', descricao: 'Acesso total ao sistema e relatorios' },
            { id: 2, nome: 'atendente', descricao: 'Gerencia pedidos e cardapio do dia' },
            { id: 3, nome: 'entregador', descricao: 'Gerencia entregas e status de pedidos' }
        ])
        .onConflict('id')
        .merge();

    // 🍛 CATEGORIAS DE ALIMENTOS
    await knex('categorias_alimentos')
        .insert([
            { nome: 'BÁSICOS', limite_escolhas: 2 },
            { nome: 'PROTEÍNAS', limite_escolhas: 1 },
            { nome: 'SALADAS', limite_escolhas: 1 },
            { nome: 'ACOMPANHAMENTOS', limite_escolhas: 3 },
            { nome: 'EXTRAS', limite_escolhas: 1 }
        ])

    // 📦 TAMANHOS DE MARMITAS
    await knex('tamanhos_marmitas')
        .insert([
            { nome: 'Pequena (P)', preco_base: 15.00 },
            { nome: 'Média (M)', preco_base: 20.00 },
            { nome: 'Grande (G)', preco_base: 25.00 }
        ])

    // 💳 MÉTODOS DE PAGAMENTO
    await knex('metodos_pagamento')
        .insert([
            { nome: 'Pix' },
            { nome: 'Dinheiro' },
            { nome: 'Cartão de Crédito' },
            { nome: 'Cartão de Débito' }
        ])
}
