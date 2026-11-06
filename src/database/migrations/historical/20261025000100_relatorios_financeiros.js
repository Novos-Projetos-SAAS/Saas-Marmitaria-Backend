const periodo = `(filtros->>'data_inicio' IS NULL OR p.data_pedido >= (filtros->>'data_inicio')::date)
    AND (filtros->>'data_fim' IS NULL OR p.data_pedido <= (filtros->>'data_fim')::date)`;

export async function up(knex) {
    // Same identifier whitespace policy as the independent payment verifier (JS trim).
    const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    await knex.raw(`CREATE VIEW vw_rel_pedidos_financeiros AS
        WITH base AS (
            SELECT p.*, f.id AS pagamento_id, f.status AS status_tentativa,
                f.valor_pago_provider_centavos, f.pago_em, f.estornado_em,
                f.capture_method, f.installments,
                COALESCE(f.comprovado, false) AS pagamento_confirmado,
                (p.criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS data_pedido,
                (f.pago_em AT TIME ZONE 'America/Sao_Paulo')::date AS data_confirmacao,
                (f.estornado_em AT TIME ZONE 'America/Sao_Paulo')::date AS data_estorno
            FROM pedidos p
            LEFT JOIN LATERAL (
                SELECT t.*, COALESCE(t.status IN ('PAGA','LIQUIDADA','ESTORNADA')
                    AND t.provider_verified_at IS NOT NULL AND t.pago_em IS NOT NULL
                    AND btrim(t.transaction_nsu, '${whitespace}') <> ''
                    AND btrim(t.invoice_slug, '${whitespace}') <> ''
                    AND t.capture_method IN ('pix','credit_card')
                    AND t.valor_base_provider_centavos = t.valor_centavos
                    AND t.valor_centavos = ROUND(p.valor_total * 100), false) AS comprovado
                FROM pagamentos t WHERE t.pedido_id = p.id
                ORDER BY comprovado DESC, t.tentativa_numero DESC, t.id DESC LIMIT 1
            ) f ON p.fluxo_pagamento = 'INFINITEPAY'
        ), classificacao AS (
            SELECT base.*,
                pagamento_confirmado AND status_tentativa = 'ESTORNADA' AND estornado_em IS NOT NULL AS estorno_comprovado,
                CASE WHEN fluxo_pagamento = 'POSTERIOR' THEN 'POSTERIOR'
                    WHEN status_tentativa IS NULL THEN 'SEM_TENTATIVA'
                    WHEN status_tentativa IN ('PAGA','LIQUIDADA','ESTORNADA') AND NOT pagamento_confirmado THEN 'PENDENTE_VERIFICACAO'
                    WHEN status_tentativa = 'ESTORNADA' AND estornado_em IS NULL THEN 'PENDENTE_VERIFICACAO'
                    ELSE status_tentativa::text END AS situacao_financeira,
                CASE WHEN fluxo_pagamento = 'POSTERIOR' THEN status::text <> 'Cancelado' AND deletado_em IS NULL
                    ELSE pagamento_confirmado AND status_tentativa IN ('PAGA','LIQUIDADA') END AS venda_considerada
            FROM base
        )
        SELECT classificacao.*, CASE WHEN venda_considerada THEN valor_total ELSE 0::numeric END AS valor_venda
        FROM classificacao`);

    const sqlFunction = (name, returns, select) => knex.raw(`CREATE OR REPLACE FUNCTION ${name}(filtros json)
        RETURNS TABLE (${returns}) LANGUAGE SQL STABLE AS $$ ${select} $$`);
    await sqlFunction('fn_rel_faturamento_periodo', 'data_faturamento text, qtd_pedidos bigint, ticket_medio numeric, total_faturado numeric', `
        SELECT to_char(p.data_pedido, 'DD/MM/YYYY'), count(p.id),
            COALESCE(round(avg(p.valor_total) FILTER (WHERE p.venda_considerada), 2), 0), sum(p.valor_venda)
        FROM vw_rel_pedidos_financeiros p
        WHERE ${periodo} AND p.deletado_em IS NULL
            AND (filtros->>'status' IS NULL OR filtros->>'status' = 'todos' OR p.status::text = filtros->>'status')
        GROUP BY p.data_pedido ORDER BY p.data_pedido`);
    await sqlFunction('fn_rel_vendas_tamanho', 'tamanho_nome varchar, qtd_vendida bigint, faturamento_tamanho numeric', `
        SELECT tm.nome, sum(ip.quantidade)::bigint, sum(ip.subtotal)
        FROM itens_pedido ip JOIN vw_rel_pedidos_financeiros p ON p.id = ip.pedido_id
        JOIN tamanhos_marmitas tm ON tm.id = ip.tamanho_marmita_id
        WHERE ${periodo} AND p.deletado_em IS NULL AND p.status::text <> 'Cancelado' AND p.venda_considerada
        GROUP BY tm.nome ORDER BY sum(ip.quantidade) DESC, tm.nome`);
    await sqlFunction('fn_rel_saida_alimentos', 'nome_alimento varchar, categoria_nome varchar, qtd_escolhida bigint', `
        SELECT a.nome, c.nome, sum(ip.quantidade)::bigint
        FROM composicao_item_pedido cip JOIN itens_pedido ip ON ip.id = cip.item_pedido_id
        JOIN vw_rel_pedidos_financeiros p ON p.id = ip.pedido_id
        JOIN alimentos a ON a.id = cip.alimento_id JOIN categorias_alimentos c ON c.id = a.categoria_id
        WHERE ${periodo} AND p.deletado_em IS NULL AND p.status::text <> 'Cancelado' AND p.venda_considerada
        GROUP BY a.nome, c.nome ORDER BY sum(ip.quantidade) DESC, a.nome`);
    await sqlFunction('fn_rel_vendas_marmitas_especiais', 'codigo integer, marmita_nome varchar, qtd_vendida bigint, total_faturado numeric', `
        SELECT ip.marmita_especial_id, COALESCE(ip.nome_item_snapshot, me.nome, 'Marmita Especial')::varchar,
            sum(ip.quantidade)::bigint, sum(ip.subtotal)
        FROM itens_pedido ip JOIN vw_rel_pedidos_financeiros p ON p.id = ip.pedido_id
        LEFT JOIN marmitas_especiais me ON me.id = ip.marmita_especial_id
        WHERE ${periodo} AND ip.marmita_especial_id IS NOT NULL AND p.deletado_em IS NULL
            AND p.status::text <> 'Cancelado' AND p.venda_considerada
        GROUP BY ip.marmita_especial_id, COALESCE(ip.nome_item_snapshot, me.nome, 'Marmita Especial')
        ORDER BY sum(ip.subtotal) DESC, sum(ip.quantidade) DESC, 2`);
    await sqlFunction('fn_rel_clientes_frequentes', 'telefone_cliente varchar, nome_cliente varchar, qtd_pedidos bigint, valor_gasto numeric', `
        SELECT p.telefone_cliente, p.nome_cliente, count(p.id), sum(p.valor_venda)
        FROM vw_rel_pedidos_financeiros p WHERE ${periodo} AND p.deletado_em IS NULL
            AND (p.fluxo_pagamento = 'POSTERIOR' OR p.venda_considerada)
        GROUP BY p.telefone_cliente, p.nome_cliente ORDER BY count(p.id) DESC, sum(p.valor_venda) DESC`);
    await sqlFunction('fn_rel_historico_vendas_financeiro', `pedido_id integer, data_hora text, nome_cliente varchar,
        tipo_pedido text, status text, valor_total numeric, fluxo_pagamento varchar, situacao_financeira text, valor_considerado numeric`, `
        SELECT p.id, to_char(p.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), p.nome_cliente,
            p.tipo_pedido::text, p.status::text, p.valor_total, p.fluxo_pagamento, p.situacao_financeira, p.valor_venda
        FROM vw_rel_pedidos_financeiros p WHERE ${periodo} AND p.status::text <> 'Cancelado' AND p.deletado_em IS NULL
            AND (filtros->>'tipo_pedido' IS NULL OR filtros->>'tipo_pedido' = 'todos' OR p.tipo_pedido::text = filtros->>'tipo_pedido')
        ORDER BY p.criado_em DESC, p.id DESC`);
    await knex.raw(`CREATE FUNCTION fn_rel_pagamentos_infinitepay(filtros json)
        RETURNS TABLE (pedido_id integer, metodo_pagamento varchar, meio_confirmado varchar, status_pedido text, situacao_financeira text,
            data_pedido text, data_confirmacao text, data_estorno text, valor_original numeric,
            valor_confirmado numeric, valor_pago_comprador numeric, valor_estornado numeric, taxas numeric, valor_liquido numeric)
        LANGUAGE plpgsql STABLE AS $$
        DECLARE criterio text := COALESCE(NULLIF(filtros->>'criterio_temporal',''), 'pedido');
        BEGIN
            IF criterio NOT IN ('pedido','confirmacao','estorno') THEN RAISE EXCEPTION 'Critério temporal inválido'; END IF;
            RETURN QUERY SELECT p.id, mp.nome, CASE WHEN p.pagamento_confirmado THEN p.capture_method END, p.status::text, p.situacao_financeira,
                to_char(p.data_pedido,'DD/MM/YYYY'), CASE WHEN p.pagamento_confirmado THEN to_char(p.pago_em AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI') END,
                CASE WHEN p.estorno_comprovado THEN to_char(p.estornado_em AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI') END,
                p.valor_total, CASE WHEN p.pagamento_confirmado THEN p.valor_total END,
                CASE WHEN p.pagamento_confirmado THEN p.valor_pago_provider_centavos::numeric / 100 END,
                NULL::numeric, NULL::numeric, NULL::numeric
            FROM vw_rel_pedidos_financeiros p JOIN metodos_pagamento mp ON mp.id = p.metodo_pagamento_id
            CROSS JOIN LATERAL (SELECT CASE criterio WHEN 'confirmacao' THEN CASE WHEN p.pagamento_confirmado THEN p.data_confirmacao END
                WHEN 'estorno' THEN CASE WHEN p.estorno_comprovado THEN p.data_estorno END ELSE p.data_pedido END AS dia) d
            WHERE p.fluxo_pagamento = 'INFINITEPAY' AND d.dia IS NOT NULL
                AND (filtros->>'data_inicio' IS NULL OR d.dia >= (filtros->>'data_inicio')::date)
                AND (filtros->>'data_fim' IS NULL OR d.dia <= (filtros->>'data_fim')::date)
                AND (filtros->>'situacao_financeira' IS NULL OR filtros->>'situacao_financeira' = 'todos'
                    OR p.situacao_financeira = filtros->>'situacao_financeira')
            ORDER BY d.dia DESC, p.id DESC;
        END $$`);

    const histories = await knex('catalogo_relatorios').where({ funcao_db: 'fn_rel_historico_vendas' });
    for (const history of histories) {
        const columns = history.colunas_config.map(col => col.chave === 'valor_total' ? { ...col, label: 'Valor do pedido (R$)', totalizar: false } : col);
        for (const col of [
            { chave: 'fluxo_pagamento', label: 'Fluxo', totalizar: false },
            { chave: 'situacao_financeira', label: 'Situação financeira', totalizar: false },
            { chave: 'valor_considerado', label: 'Venda considerada (R$)', totalizar: true }
        ]) if (!columns.some(c => c.chave === col.chave)) columns.push(col);
        await knex('catalogo_relatorios').where({ id: history.id }).update({ funcao_db: 'fn_rel_historico_vendas_financeiro', colunas_config: JSON.stringify(columns) });
    }
    await knex('catalogo_relatorios').insert({ nome: 'Pagamentos InfinitePay',
        descricao: 'Pedidos e pagamentos por data do pedido, confirmação ou estorno. Valores brutos; taxas, líquido e valor estornado não informados.',
        funcao_db: 'fn_rel_pagamentos_infinitepay', ativo: true,
        filtros_config: JSON.stringify([
            { nome: 'data_inicio', label: 'Data inicial (São Paulo)', tipo: 'date' },
            { nome: 'data_fim', label: 'Data final (São Paulo)', tipo: 'date' },
            { nome: 'criterio_temporal', label: 'Data de referência', tipo: 'select', opcoes: ['pedido','confirmacao','estorno'] },
            { nome: 'situacao_financeira', label: 'Situação financeira', tipo: 'select', opcoes: ['todos','SEM_TENTATIVA','CRIANDO','AGUARDANDO','INCERTA','PENDENTE_VERIFICACAO','PAGA','LIQUIDADA','ESTORNADA','FALHOU','EXPIRADA','CANCELADA','DIVERGENTE'] }
        ]), colunas_config: JSON.stringify([
            ['pedido_id','Pedido'], ['metodo_pagamento','Método do pedido'], ['meio_confirmado','Meio confirmado'], ['status_pedido','Estado operacional'], ['situacao_financeira','Situação financeira'],
            ['data_pedido','Data do pedido (SP)'], ['data_confirmacao','Confirmação (SP)'], ['data_estorno','Estorno (SP)'],
            ['valor_original','Valor do pedido (R$)'], ['valor_confirmado','Base confirmada (R$)'], ['valor_pago_comprador','Pago pelo comprador (R$)'],
            ['valor_estornado','Valor estornado (R$)'], ['taxas','Taxas (R$)'], ['valor_liquido','Líquido recebido (R$)']
        ].map(([chave, label]) => ({ chave, label, totalizar: false })))
    });
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve os relatórios, dados e estruturas existentes.');
}
