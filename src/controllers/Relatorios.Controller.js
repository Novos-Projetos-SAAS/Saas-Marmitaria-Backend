import connection from "../database/connection.js";
import { lancarErro } from "../utils/errorUtils.js";

export const listarCatalogoRelatorios = async (req, res, next) => {
    try {
        const relatorios = await connection('catalogo_relatorios')
            .where('ativo', true)
            .orderByRaw(`
                CASE funcao_db
                    WHEN 'fn_rel_faturamento_periodo' THEN 10
                    WHEN 'fn_rel_pagamentos_infinitepay' THEN 11
                    WHEN 'fn_rel_historico_vendas' THEN 20
                    WHEN 'fn_rel_historico_vendas_financeiro' THEN 20
                    WHEN 'fn_rel_saida_alimentos' THEN 30
                    WHEN 'fn_rel_vendas_tamanho' THEN 40
                    WHEN 'fn_rel_vendas_marmitas_especiais' THEN 41
                    WHEN 'fn_rel_clientes_frequentes' THEN 50
                    WHEN 'fn_rel_listagem_alimentos' THEN 60
                    WHEN 'fn_rel_listagem_categorias' THEN 70
                    WHEN 'fn_rel_listagem_tamanhos' THEN 80
                    WHEN 'fn_rel_listagem_marmitas_especiais' THEN 81
                    WHEN 'fn_rel_listagem_pagamentos' THEN 90
                    ELSE 999
                END ASC,
                id ASC
            `)
            .select([
                'id',
                'nome',
                'descricao',
                'funcao_db',
                'filtros_config',
                'colunas_config'
            ]);

        return res.status(200).json({
            status: 'success',
            data: relatorios
        });
    } catch (error) {
        next(error);
    }
};

export const gerarRelatorio = async (req, res, next) => {

    try {

        const { id } = req.params;
        const filtros = req.body;

        if (!id) {
            return next(lancarErro('O parâmetro ID do relatório é obrigatório.', 400));
        }

        const relatorio = await connection('catalogo_relatorios')
            .where('id', id)
            .where('ativo', true)
            .first();

        if (!relatorio) {
            return next(lancarErro('Relatório não encontrado ou inativo.', 404));
        }

        const filtrosJson = JSON.stringify(filtros || {});

        const resultado = await connection.raw(
            `SELECT * FROM ${relatorio.funcao_db}(?)`,
            [filtrosJson]
        );

        await connection('logs').insert({
            tipo: 'ACAO',
            usuario_id: req.usuario.id, // Assumindo que seu middleware de auth injeta o req.usuario
            metodo: req.method,
            endpoint: req.originalUrl,
            acao: 'RELATORIOS.GERAR',
            descricao: `O usuário ${req.usuario.nome} gerou o relatório: ${relatorio.nome}`,
            payload: JSON.stringify({
                relatorio_id: id,
                nome_relatorio: relatorio.nome,
                filtros_utilizados: filtros
            })
        });

        return res.status(200).json({
            status: 'success',
            data: {
                nome: relatorio.nome,
                notas: notasRelatorio(relatorio.funcao_db),
                colunas: relatorio.colunas_config,
                dados: resultado.rows
            }
        });

    } catch (error) {
        next(error);
    }
}

const notasRelatorio = (funcao) => {
    const base = 'Datas em America/Sao_Paulo. ';
    if (funcao === 'fn_rel_pagamentos_infinitepay') return base +
        'Filtro pela data selecionada: pedido, confirmação independente ou estorno comprovado. Uma linha por pedido. ' +
        'Base confirmada inclui pagamentos posteriormente estornados; não é receita líquida. Cancelamento operacional não é estorno. ' +
        'LIQUIDADA não comprova repasse bancário. Valor pago pelo comprador não é líquido do estabelecimento. ' +
        'Valor estornado, taxas e líquido não informados pelo contrato homologado.';
    if (['fn_rel_faturamento_periodo','fn_rel_historico_vendas_financeiro','fn_rel_vendas_tamanho',
        'fn_rel_vendas_marmitas_especiais','fn_rel_saida_alimentos','fn_rel_clientes_frequentes'].includes(funcao)) return base +
        'Filtro pela criação do pedido. Vendas consideradas: POSTERIOR conforme regra legada e InfinitePay com prova independente válida, sem estado ESTORNADA. ' +
        'Cancelamento operacional não apaga pagamento comprovado; relatórios de itens excluem cancelados. ' +
        'Quantidade de pedidos no faturamento inclui pendentes e cancelados; ticket médio usa apenas vendas consideradas. ' +
        'Valores brutos, sem dedução de taxas ou inferência de repasse bancário. Histórico distingue valor do pedido de venda considerada.';
    return base;
};
