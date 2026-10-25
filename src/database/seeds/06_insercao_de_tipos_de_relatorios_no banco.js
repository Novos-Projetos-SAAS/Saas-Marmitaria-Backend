/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
export async function seed(knex) {
    const relatorios = [
        // --- RELATÓRIOS GERENCIAIS ---
        {
            nome: 'Faturamento por Período',
            descricao: 'Faturamento diário agrupado, com cálculo de ticket médio e quantidade de pedidos.',
            funcao_db: 'fn_rel_faturamento_periodo',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' },
                { nome: 'status', tipo: 'select', label: 'Status do Pedido', opcoes: ['todos', 'Pendente', 'Em Preparo', 'Pronto para Retirada', 'Saiu para Entrega', 'Entregue', 'Cancelado'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'data_faturamento', label: 'Data' },
                { chave: 'qtd_pedidos', label: 'Pedidos (operacional)', totalizar: true },
                { chave: 'ticket_medio', label: 'Ticket Médio (R$)' },
                { chave: 'total_faturado', label: 'Vendas consideradas (R$)', totalizar: true }
            ]),
            ativo: true
        },
        {
            nome: 'Histórico de Vendas Completo',
            descricao: 'Listagem detalhada de todos os pedidos realizados no período.',
            funcao_db: 'fn_rel_historico_vendas_financeiro',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' },
                { nome: 'tipo_pedido', tipo: 'select', label: 'Tipo de Entrega', opcoes: ['todos', 'Presencial', 'Remoto'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'pedido_id', label: 'Nº Pedido' },
                { chave: 'data_hora', label: 'Data e Hora' },
                { chave: 'nome_cliente', label: 'Cliente' },
                { chave: 'tipo_pedido', label: 'Tipo' },
                { chave: 'status', label: 'Status' },
                { chave: 'valor_total', label: 'Valor do pedido (R$)', totalizar: false },
                { chave: 'fluxo_pagamento', label: 'Fluxo', totalizar: false },
                { chave: 'situacao_financeira', label: 'Situação financeira', totalizar: false },
                { chave: 'valor_considerado', label: 'Venda considerada (R$)', totalizar: true }
            ]),
            ativo: true
        },
        {
            nome: 'Curva de Saída de Alimentos',
            descricao: 'Ranking dos ingredientes e misturas mais escolhidos nas marmitas para controle de compras.',
            funcao_db: 'fn_rel_saida_alimentos',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'nome_alimento', label: 'Alimento' },
                { chave: 'categoria_nome', label: 'Categoria' },
                { chave: 'qtd_escolhida', label: 'Vezes Escolhido', totalizar: true }
            ]),
            ativo: true
        },
        {
            nome: 'Vendas por Tamanho de Marmita',
            descricao: 'Volume de vendas e faturamento agrupado pelo tamanho da marmita.',
            funcao_db: 'fn_rel_vendas_tamanho',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'tamanho_nome', label: 'Tamanho da Marmita' },
                { chave: 'qtd_vendida', label: 'Quantidade Vendida', totalizar: true },
                { chave: 'faturamento_tamanho', label: 'Faturamento (R$)', totalizar: true }
            ]),
            ativo: true
        },
        {
            nome: 'Clientes Mais Frequentes (Ranking)',
            descricao: 'Identifica os clientes que mais pediram na marmitaria no período selecionado.',
            funcao_db: 'fn_rel_clientes_frequentes',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'telefone_cliente', label: 'Telefone' },
                { chave: 'nome_cliente', label: 'Nome do Cliente' },
                { chave: 'qtd_pedidos', label: 'Total de Pedidos', totalizar: true },
                { chave: 'valor_gasto', label: 'Valor Gasto (R$)', totalizar: true }
            ]),
            ativo: true
        },

        // --- RELATÓRIOS CADASTRAIS ---
        {
            nome: 'Listagem de Alimentos (Cardápio)',
            descricao: 'Relação de todos os alimentos cadastrados e sua disponibilidade.',
            funcao_db: 'fn_rel_listagem_alimentos',
            filtros_config: JSON.stringify([
                { nome: 'busca', tipo: 'text', label: 'Buscar por Nome' },
                { nome: 'disponibilidade', tipo: 'select', label: 'Status', opcoes: ['todos', 'Disponível Hoje', 'Indisponível'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'id', label: 'Código' },
                { chave: 'nome', label: 'Alimento' },
                { chave: 'categoria_nome', label: 'Categoria' },
                { chave: 'status_disponivel', label: 'Disponível Hoje?' }
            ]),
            ativo: true
        },
        {
            nome: 'Listagem de Categorias',
            descricao: 'Relação das categorias de alimentos e limites de escolha.',
            funcao_db: 'fn_rel_listagem_categorias',
            filtros_config: JSON.stringify([
                { nome: 'status', tipo: 'select', label: 'Status', opcoes: ['todos', 'Ativo', 'Inativo'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'id', label: 'Código' },
                { chave: 'nome', label: 'Categoria' },
                { chave: 'limite_escolhas', label: 'Limite na Marmita' },
                { chave: 'status_ativo', label: 'Situação' }
            ]),
            ativo: true
        },
        {
            nome: 'Listagem de Tamanhos de Marmitas',
            descricao: 'Relação de tamanhos disponíveis e seus preços base.',
            funcao_db: 'fn_rel_listagem_tamanhos',
            filtros_config: JSON.stringify([
                { nome: 'status', tipo: 'select', label: 'Status', opcoes: ['todos', 'Ativo', 'Inativo'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'id', label: 'Código' },
                { chave: 'nome', label: 'Tamanho' },
                { chave: 'preco_base', label: 'Preço Base (R$)' },
                { chave: 'status_ativo', label: 'Situação' }
            ]),
            ativo: true
        },
        {
            nome: 'Listagem de Métodos de Pagamento',
            descricao: 'Relação das formas de pagamento aceitas no sistema.',
            funcao_db: 'fn_rel_listagem_pagamentos',
            filtros_config: JSON.stringify([
                { nome: 'status', tipo: 'select', label: 'Status', opcoes: ['todos', 'Ativo', 'Inativo'] }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'id', label: 'Código' },
                { chave: 'nome', label: 'Método de Pagamento' },
                { chave: 'status_ativo', label: 'Situação' }
            ]),
            ativo: true
        }
    ];

    // Loop de inserção/atualização (Upsert)
    for (const relatorio of relatorios) {
        const existe = await knex('catalogo_relatorios')
            .where({ funcao_db: relatorio.funcao_db })
            .first();

        if (!existe) {
            await knex('catalogo_relatorios').insert(relatorio);
            console.log(`✅ Relatório inserido: ${relatorio.nome}`);
        } else {
            await knex('catalogo_relatorios')
                .where({ funcao_db: relatorio.funcao_db })
                .update({
                    nome: relatorio.nome,
                    descricao: relatorio.descricao,
                    filtros_config: relatorio.filtros_config,
                    colunas_config: relatorio.colunas_config,
                    ativo: relatorio.ativo,
                    atualizado_em: knex.fn.now()
                });
            console.log(`🔄 Relatório atualizado: ${relatorio.nome}`);
        }
    }
}
