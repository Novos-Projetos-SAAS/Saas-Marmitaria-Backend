/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
import chalk from 'chalk';
import logSymbols from 'log-symbols';

// Catálogo legado reutilizado pelo bootstrap seguro, sem executar o reset.
export const BASE_RBAC_PERMISSIONS = [
        // Módulo: Usuários
        { nome: 'usuarios.listar', descricao: 'Visualizar lista de funcionários' },
        { nome: 'usuarios.criar', descricao: 'Cadastrar novos funcionários' },
        { nome: 'usuarios.editar', descricao: 'Editar dados de funcionários' },
        { nome: 'usuarios.deletar', descricao: 'Remover funcionários do sistema' },
        { nome: 'usuarios.visualizar', descricao: 'Visualizar detalhes do usuário' },
        { nome: 'usuarios.reativar', descricao: 'Reativar funcionário do sistema'},

        // Módulo: Cardápio (Alimentos)
        { nome: 'cardapio.listar', descricao: 'Visualizar itens do cardápio' },
        { nome: 'cardapio.gerenciar', descricao: 'Criar, editar e excluir itens do cardápio' },
        { nome: 'cardapio.disponibilidade', descricao: 'Alterar se o item está disponível hoje' },

        // Módulo: Pedidos
        { nome: 'pedidos.listar', descricao: 'Visualizar painel de pedidos' },
        { nome: 'pedidos.status', descricao: 'Alterar status do pedido (Preparando, Saiu p/ Entrega, etc)' },
        { nome: 'pedidos.cancelar', descricao: 'Cancelar pedidos ativos' },
        { nome: 'pedidos.editar', descricao: 'Editar pedido' },

        // Módulo: Configurações da Loja
        { nome: 'loja.status', descricao: 'Abrir e fechar a loja para receber pedidos' },
        { nome: 'loja.configurar', descricao: 'Editar horários, taxas de entrega e tamanhos' },

        // Módulo: Relatórios
        { nome: 'relatorios.financeiro', descricao: 'Visualizar faturamento e lucros' },
        { nome: 'relatorios.vendas', descricao: 'Visualizar estatísticas de vendas' },

        { nome: 'permissoes.listar', descricao: 'Visualizar lista de todas as permissões do sistema' },
        { nome: 'permissoes.visualizar', descricao: 'Visualizar quais permissões um usuário possui' },
        { nome: 'permissoes.editar', descricao: 'Alterar as permissões de um usuário' },

        // --- CATEGORIAS DE ALIMENTOS ---
        { nome: 'categorias_alimentos.listar', descricao: 'Visualizar categorias de alimentos' },
        { nome: 'categorias_alimentos.criar', descricao: 'Cadastrar novas categorias de alimentos' },
        { nome: 'categorias_alimentos.editar', descricao: 'Editar categorias de alimentos existentes' },
        { nome: 'categorias_alimentos.deletar', descricao: 'Remover categorias de alimentos do sistema' },

        // --- ALIMENTOS ---
        { nome: 'alimentos.listar', descricao: 'Visualizar lista de alimentos' },
        { nome: 'alimentos.criar', descricao: 'Cadastrar novos alimentos' },
        { nome: 'alimentos.editar', descricao: 'Editar dados dos alimentos' },
        { nome: 'alimentos.deletar', descricao: 'Remover alimentos do sistema' },
        { nome: 'alimentos.estoque', descricao: 'Alterar disponibilidade de itens' },

        // --- TAMANHOS DE MARMITAS ---
        { nome: 'tamanhos_marmitas.listar', descricao: 'Visualizar tamanhos de marmitas' },
        { nome: 'tamanhos_marmitas.criar', descricao: 'Cadastrar novos tamanhos e preços' },
        { nome: 'tamanhos_marmitas.editar', descricao: 'Editar preços e regras de tamanhos' },
        { nome: 'tamanhos_marmitas.deletar', descricao: 'Remover tamanhos de marmitas do sistema' },

        // --- MÉTODOS DE PAGAMENTOS --- 
        { nome: 'metodos_pagamento.listar', descricao: 'Visualizar métodos de pagamento' },
        { nome: 'metodos_pagamento.criar', descricao: 'Cadastrar novos métodos de pagamento' },
        { nome: 'metodos_pagamento.editar', descricao: 'Editar métodos de pagamento existentes' },
        { nome: 'metodos_pagamento.deletar', descricao: 'Remover métodos de pagamento do sistema' },
        { nome: 'metodos_pagamento.restaurar', descricao: 'Restaurar métodos de pagamento excluídos' },

        // --- NÍVEIS DE ACESSO ---
        { nome: 'niveis_acesso.listar', descricao: 'Listar níveis de acesso' },
        { nome: 'niveis_acesso.criar', descricao: 'Criar novos níveis de acesso' },
        { nome: 'niveis_acesso.editar', descricao: 'Editar níveis de acesso existentes' },
        { nome: 'niveis_acesso.deletar', descricao: 'Remover níveis de acesso do sistema' },
        { nome: 'niveis_acesso.restaurar', descricao: 'Restaurar níveis de acesso excluídos' }

];

export async function seed(knex) {

    // Apaga o catálogo/vínculos RBAC. Nunca reexecutar em produção.
    if(process.env.NODE_ENV==='production' || process.env.INFINITEPAY_MODE==='production') {
        throw new Error('Seed de reset RBAC bloqueada em produção. Use a seed 14 específica da InfinitePay.');
    }
    await knex('permissoes_usuarios').del();
    await knex('permissoes').del();

    // 2. Definição das permissões por módulo
    const listaPermissoes = BASE_RBAC_PERMISSIONS;


    // 3. Insere apenas as permissões no banco
    await knex('permissoes').insert(listaPermissoes);

    console.log(`\n${logSymbols.success} ${chalk.green('SEED DE PERMISSÕES CONCLUÍDO')}`);
    console.log(`${logSymbols.success} ${chalk.green(`${listaPermissoes.length} permissões cadastradas no catálogo.`)}\n`);

};
