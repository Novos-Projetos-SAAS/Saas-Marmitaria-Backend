/**
 * Adiciona relatórios específicos para marmitas especiais.
 *
 * 1. Vendas de Marmitas Especiais
 *    - usa o snapshot do nome salvo no item do pedido;
 *    - exclui pedidos cancelados e removidos;
 *    - mantém o histórico correto mesmo após edição do cadastro.
 *
 * 2. Listagem de Marmitas Especiais
 *    - exibe somente cadastros não removidos;
 *    - permite filtrar por status ativo/inativo.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.raw(`
        CREATE OR REPLACE FUNCTION fn_rel_vendas_marmitas_especiais(filtros json)
        RETURNS TABLE (
            codigo integer,
            marmita_nome varchar,
            qtd_vendida bigint,
            total_faturado numeric
        ) AS $$
        DECLARE
            v_data_inicio date := (filtros->>'data_inicio')::date;
            v_data_fim date := (filtros->>'data_fim')::date;
        BEGIN
            RETURN QUERY
            SELECT
                ip.marmita_especial_id AS codigo,
                COALESCE(
                    ip.nome_item_snapshot,
                    me.nome,
                    'Marmita Especial'
                )::varchar AS marmita_nome,
                SUM(ip.quantidade)::bigint AS qtd_vendida,
                COALESCE(SUM(ip.subtotal), 0)::numeric AS total_faturado
            FROM itens_pedido ip
            JOIN pedidos p
                ON p.id = ip.pedido_id
            LEFT JOIN marmitas_especiais me
                ON me.id = ip.marmita_especial_id
            WHERE
                ip.marmita_especial_id IS NOT NULL
                AND p.deletado_em IS NULL
                AND p.status::text <> 'Cancelado'
                AND (v_data_inicio IS NULL OR p.criado_em::date >= v_data_inicio)
                AND (v_data_fim IS NULL OR p.criado_em::date <= v_data_fim)
            GROUP BY
                ip.marmita_especial_id,
                COALESCE(
                    ip.nome_item_snapshot,
                    me.nome,
                    'Marmita Especial'
                )
            ORDER BY
                total_faturado DESC,
                qtd_vendida DESC,
                marmita_nome ASC;
        END;
        $$ LANGUAGE plpgsql;
    `);

    await knex.raw(`
        CREATE OR REPLACE FUNCTION fn_rel_listagem_marmitas_especiais(filtros json)
        RETURNS TABLE (
            id integer,
            nome varchar,
            preco numeric,
            status_ativo text
        ) AS $$
        DECLARE
            v_status text := filtros->>'status';
        BEGIN
            RETURN QUERY
            SELECT
                me.id,
                me.nome,
                me.preco,
                CASE
                    WHEN me.ativo THEN 'Ativo'
                    ELSE 'Inativo'
                END AS status_ativo
            FROM marmitas_especiais me
            WHERE
                me.deletado_em IS NULL
                AND (
                    v_status IS NULL
                    OR v_status = 'todos'
                    OR (v_status = 'Ativo' AND me.ativo = true)
                    OR (v_status = 'Inativo' AND me.ativo = false)
                )
            ORDER BY
                me.nome ASC,
                me.id ASC;
        END;
        $$ LANGUAGE plpgsql;
    `);

    const relatorios = [
        {
            nome: 'Vendas de Marmitas Especiais',
            descricao: 'Quantidade vendida e faturamento das marmitas especiais no período selecionado.',
            funcao_db: 'fn_rel_vendas_marmitas_especiais',
            filtros_config: JSON.stringify([
                { nome: 'data_inicio', tipo: 'date', label: 'Data Inicial' },
                { nome: 'data_fim', tipo: 'date', label: 'Data Final' }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'codigo', label: 'Código' },
                { chave: 'marmita_nome', label: 'Marmita Especial' },
                { chave: 'qtd_vendida', label: 'Quantidade Vendida', totalizar: true },
                { chave: 'total_faturado', label: 'Faturamento (R$)', totalizar: true }
            ]),
            ativo: true
        },
        {
            nome: 'Listagem de Marmitas Especiais',
            descricao: 'Relação das marmitas especiais cadastradas, com preço atual e situação.',
            funcao_db: 'fn_rel_listagem_marmitas_especiais',
            filtros_config: JSON.stringify([
                {
                    nome: 'status',
                    tipo: 'select',
                    label: 'Status',
                    opcoes: ['todos', 'Ativo', 'Inativo']
                }
            ]),
            colunas_config: JSON.stringify([
                { chave: 'id', label: 'Código' },
                { chave: 'nome', label: 'Marmita Especial' },
                { chave: 'preco', label: 'Preço Atual (R$)' },
                { chave: 'status_ativo', label: 'Situação' }
            ]),
            ativo: true
        }
    ];

    for (const relatorio of relatorios) {
        const existente = await knex('catalogo_relatorios')
            .where({ funcao_db: relatorio.funcao_db })
            .first();

        if (existente) {
            await knex('catalogo_relatorios')
                .where({ id: existente.id })
                .update({
                    nome: relatorio.nome,
                    descricao: relatorio.descricao,
                    filtros_config: relatorio.filtros_config,
                    colunas_config: relatorio.colunas_config,
                    ativo: relatorio.ativo,
                    atualizado_em: knex.fn.now()
                });
        } else {
            await knex('catalogo_relatorios').insert(relatorio);
        }
    }
}

/**
 * Remove somente os relatórios e funções adicionados por esta migration.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex('catalogo_relatorios')
        .whereIn('funcao_db', [
            'fn_rel_vendas_marmitas_especiais',
            'fn_rel_listagem_marmitas_especiais'
        ])
        .del();

    await knex.raw(
        'DROP FUNCTION IF EXISTS fn_rel_vendas_marmitas_especiais(json);'
    );

    await knex.raw(
        'DROP FUNCTION IF EXISTS fn_rel_listagem_marmitas_especiais(json);'
    );
}
