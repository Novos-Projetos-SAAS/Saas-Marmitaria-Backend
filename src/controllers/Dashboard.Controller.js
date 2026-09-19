import connection from "../database/connection.js";
import { lancarErro } from "../utils/errorUtils.js";

const STATUS_CANCELADO = "Cancelado";
const LIMITE_DIAS_PERIODO = 366;

const converterData = (valor) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;

    const [ano, mes, dia] = valor.split("-").map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));

    if (
        data.getUTCFullYear() !== ano ||
        data.getUTCMonth() !== mes - 1 ||
        data.getUTCDate() !== dia
    ) {
        return null;
    }

    return data;
};

const obterHoje = () => {
    const partes = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));

    return `${valores.year}-${valores.month}-${valores.day}`;
};

const validarPeriodo = (query) => {
    const dataInicio = String(query.data_inicio || obterHoje());
    const dataFim = String(query.data_fim || dataInicio);
    const inicio = converterData(dataInicio);
    const fim = converterData(dataFim);

    if (!inicio || !fim) {
        lancarErro("Informe as datas no formato AAAA-MM-DD.", 400);
    }

    if (inicio > fim) {
        lancarErro("A data inicial não pode ser posterior à data final.", 400);
    }

    const quantidadeDias = Math.floor((fim - inicio) / 86400000) + 1;

    if (quantidadeDias > LIMITE_DIAS_PERIODO) {
        lancarErro(`O período da dashboard deve possuir no máximo ${LIMITE_DIAS_PERIODO} dias.`, 400);
    }

    return { dataInicio, dataFim };
};

const filtrarPeriodo = (query, dataInicio, dataFim) => query.whereRaw(
    "p.criado_em::date BETWEEN ?::date AND ?::date",
    [dataInicio, dataFim]
);

const normalizarLista = (lista, campoNumerico) => lista.map((item) => ({
    ...item,
    [campoNumerico]: Number(item[campoNumerico] || 0)
}));

export const buscarDashboard = async (req, res, next) => {
    try {
        const { dataInicio, dataFim } = validarPeriodo(req.query);

        const resumoQuery = connection("pedidos as p")
            .whereNull("p.deletado_em");

        filtrarPeriodo(resumoQuery, dataInicio, dataFim);

        const ultimoPedidoQuery = connection("pedidos as p")
            .whereNull("p.deletado_em");

        filtrarPeriodo(ultimoPedidoQuery, dataInicio, dataFim);

        const tamanhosQuery = connection("itens_pedido as ip")
            .join("pedidos as p", "p.id", "=", "ip.pedido_id")
            .join("tamanhos_marmitas as tm", "tm.id", "=", "ip.tamanho_marmita_id")
            .whereNull("p.deletado_em")
            .whereNot("p.status", STATUS_CANCELADO);

        filtrarPeriodo(tamanhosQuery, dataInicio, dataFim);

        const marmitasEspeciaisQuery = connection("itens_pedido as ip")
            .join("pedidos as p", "p.id", "=", "ip.pedido_id")
            .leftJoin("marmitas_especiais as me", "me.id", "=", "ip.marmita_especial_id")
            .whereNotNull("ip.marmita_especial_id")
            .whereNull("p.deletado_em")
            .whereNot("p.status", STATUS_CANCELADO);

        filtrarPeriodo(marmitasEspeciaisQuery, dataInicio, dataFim);

        const alimentosQuery = connection("composicao_item_pedido as cip")
            .join("itens_pedido as ip", "ip.id", "=", "cip.item_pedido_id")
            .join("pedidos as p", "p.id", "=", "ip.pedido_id")
            .join("alimentos as a", "a.id", "=", "cip.alimento_id")
            .whereNull("p.deletado_em")
            .whereNot("p.status", STATUS_CANCELADO);

        filtrarPeriodo(alimentosQuery, dataInicio, dataFim);

        const pagamentosQuery = connection("pedidos as p")
            .join("metodos_pagamento as mp", "mp.id", "=", "p.metodo_pagamento_id")
            .whereNull("p.deletado_em")
            .whereNot("p.status", STATUS_CANCELADO);

        filtrarPeriodo(pagamentosQuery, dataInicio, dataFim);

        const entregasQuery = connection("pedidos as p")
            .whereNull("p.deletado_em")
            .whereNot("p.status", STATUS_CANCELADO);

        filtrarPeriodo(entregasQuery, dataInicio, dataFim);

        const statusQuery = connection("pedidos as p")
            .whereNull("p.deletado_em");

        filtrarPeriodo(statusQuery, dataInicio, dataFim);

        const [
            resumo,
            ultimoPedido,
            serieResultado,
            tamanhos,
            marmitasEspeciais,
            alimentos,
            metodosPagamento,
            tiposEntrega,
            statusPedidos
        ] = await Promise.all([
            resumoQuery
                .select(
                    connection.raw(
                        "COALESCE(SUM(CASE WHEN p.status <> ? THEN p.valor_total ELSE 0 END), 0) AS faturamento",
                        [STATUS_CANCELADO]
                    ),
                    connection.raw("COUNT(p.id)::int AS quantidade_pedidos"),
                    connection.raw("COUNT(p.id) FILTER (WHERE p.status = 'Pendente')::int AS pedidos_pendentes"),
                    connection.raw("COUNT(p.id) FILTER (WHERE p.status = 'Em Preparo')::int AS pedidos_em_preparo"),
                    connection.raw("COUNT(p.id) FILTER (WHERE p.status = 'Cancelado')::int AS pedidos_cancelados"),
                    connection.raw(
                        "COALESCE(ROUND(AVG(CASE WHEN p.status <> ? THEN p.valor_total END), 2), 0) AS ticket_medio",
                        [STATUS_CANCELADO]
                    )
                )
                .first(),
            ultimoPedidoQuery
                .select("p.id", "p.nome_cliente", "p.criado_em", "p.valor_total")
                .orderBy("p.criado_em", "desc")
                .orderBy("p.id", "desc")
                .first(),
            connection.raw(`
                WITH dias AS (
                    SELECT generate_series(?::date, ?::date, INTERVAL '1 day')::date AS data
                ),
                resumo_diario AS (
                    SELECT
                        p.criado_em::date AS data,
                        COALESCE(SUM(CASE WHEN p.status <> ? THEN p.valor_total ELSE 0 END), 0) AS faturamento,
                        COUNT(p.id)::int AS pedidos
                    FROM pedidos p
                    WHERE p.deletado_em IS NULL
                      AND p.criado_em::date BETWEEN ?::date AND ?::date
                    GROUP BY p.criado_em::date
                )
                SELECT
                    TO_CHAR(dias.data, 'YYYY-MM-DD') AS data,
                    COALESCE(resumo_diario.faturamento, 0) AS faturamento,
                    COALESCE(resumo_diario.pedidos, 0)::int AS pedidos
                FROM dias
                LEFT JOIN resumo_diario ON resumo_diario.data = dias.data
                ORDER BY dias.data ASC
            `, [dataInicio, dataFim, STATUS_CANCELADO, dataInicio, dataFim]),
            tamanhosQuery
                .groupBy("tm.id", "tm.nome")
                .select("tm.nome")
                .sum({ quantidade: "ip.quantidade" })
                .orderBy("quantidade", "desc")
                .orderBy("tm.nome", "asc")
                .limit(6),
            marmitasEspeciaisQuery
                .select(
                    connection.raw(
                        "COALESCE(ip.nome_item_snapshot, me.nome, 'Marmita Especial') AS nome"
                    )
                )
                .sum({ quantidade: "ip.quantidade" })
                .groupByRaw(
                    "COALESCE(ip.nome_item_snapshot, me.nome, 'Marmita Especial')"
                )
                .orderBy("quantidade", "desc")
                .orderBy("nome", "asc")
                .limit(4),
            alimentosQuery
                .groupBy("a.id", "a.nome")
                .select("a.nome")
                .sum({ quantidade: "ip.quantidade" })
                .orderBy("quantidade", "desc")
                .orderBy("a.nome", "asc")
                .limit(8),
            pagamentosQuery
                .groupBy("mp.id", "mp.nome")
                .select("mp.nome")
                .count({ quantidade: "p.id" })
                .orderBy("quantidade", "desc")
                .orderBy("mp.nome", "asc"),
            entregasQuery
                .groupBy("p.metodo_entrega")
                .select(connection.raw("COALESCE(p.metodo_entrega::text, 'Não informado') AS nome"))
                .count({ quantidade: "p.id" })
                .orderBy("quantidade", "desc"),
            statusQuery
                .groupBy("p.status")
                .select("p.status as nome")
                .count({ quantidade: "p.id" })
                .orderBy("quantidade", "desc")
        ]);

        const serieDiaria = serieResultado.rows.map((item) => ({
            data: item.data,
            faturamento: Number(item.faturamento || 0),
            pedidos: Number(item.pedidos || 0)
        }));

        return res.status(200).json({
            status: "success",
            data: {
                periodo: {
                    data_inicio: dataInicio,
                    data_fim: dataFim
                },
                cards: {
                    faturamento: Number(resumo.faturamento || 0),
                    pedidos_pendentes: Number(resumo.pedidos_pendentes || 0),
                    ultimo_pedido: ultimoPedido ? {
                        ...ultimoPedido,
                        valor_total: Number(ultimoPedido.valor_total || 0)
                    } : null,
                    quantidade_pedidos: Number(resumo.quantidade_pedidos || 0),
                    ticket_medio: Number(resumo.ticket_medio || 0),
                    pedidos_em_preparo: Number(resumo.pedidos_em_preparo || 0),
                    pedidos_cancelados: Number(resumo.pedidos_cancelados || 0)
                },
                graficos: {
                    serie_diaria: serieDiaria,
                    tamanhos_marmita: normalizarLista(tamanhos, "quantidade"),
                    marmitas_especiais: normalizarLista(marmitasEspeciais, "quantidade"),
                    alimentos: normalizarLista(alimentos, "quantidade"),
                    metodos_pagamento: normalizarLista(metodosPagamento, "quantidade"),
                    tipos_entrega: normalizarLista(tiposEntrega, "quantidade"),
                    status_pedidos: normalizarLista(statusPedidos, "quantidade")
                }
            }
        });
    } catch (error) {
        next(error);
    }
};
