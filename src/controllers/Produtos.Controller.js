import connection from "../database/connection.js";
import { lancarErro } from "../utils/errorUtils.js";

function normalizarInteiroPositivo(valor, padrao, maximo = null) {
    const numero = Number.parseInt(valor, 10);

    if (!Number.isInteger(numero) || numero < 1) {
        return padrao;
    }

    return maximo ? Math.min(numero, maximo) : numero;
}

function normalizarNome(nome) {
    return String(nome)
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizarPreco(preco) {
    if (preco === null || preco === undefined || String(preco).trim() === '') {
        throw lancarErro('O preço do produto é obrigatório.', 400);
    }

    const valor = Number(
        typeof preco === 'string'
            ? preco.replace(',', '.')
            : preco
    );

    if (!Number.isFinite(valor) || valor < 0) {
        throw lancarErro('O preço deve ser um valor válido igual ou maior que zero.', 400);
    }

    return Number(valor.toFixed(2));
}

const TIPOS_APLICACAO_PRODUTO = [
    'PEDIDO',
    'MARMITA'
];

function normalizarTipoAplicacao(tipoAplicacao, padrao = null) {
    if (
        tipoAplicacao === null ||
        tipoAplicacao === undefined ||
        String(tipoAplicacao).trim() === ''
    ) {
        return padrao;
    }

    const tipo = String(tipoAplicacao)
        .trim()
        .toUpperCase();

    if (!TIPOS_APLICACAO_PRODUTO.includes(tipo)) {
        throw lancarErro(
            'O tipo de aplicação do produto deve ser PEDIDO ou MARMITA.',
            400
        );
    }

    return tipo;
}

function formatarProdutoParaResposta(produto) {
    if (!produto) {
        return produto;
    }

    return {
        ...produto,
        preco: produto.preco === null || produto.preco === undefined
            ? null
            : Number(produto.preco)
    };
}

async function buscarCategoriaValida(categoriaId, trx = null) {
    const query = connection('categorias_produtos')
        .where('id', categoriaId)
        .where('ativo', true)
        .whereNull('deletado_em');

    if (trx) {
        query.transacting(trx);
    }

    return query.first();
}

/**
 * ============================================================
 * CARDÁPIO PÚBLICO
 * ============================================================
 */
export const listarProdutosCardapio = async (req, res, next) => {
    try {
        const { categoria_id, tipo_aplicacao } = req.query;

        let tipoAplicacaoNormalizado = null;

        try {
            tipoAplicacaoNormalizado = normalizarTipoAplicacao(
                tipo_aplicacao
            );
        } catch (error) {
            return next(error);
        }

        const query = connection('produtos as p')
            .join(
                'categorias_produtos as cp',
                'p.categoria_produto_id',
                '=',
                'cp.id'
            )
            .select([
                'p.id',
                'p.nome',
                'p.descricao',
                'p.preco',
                'p.ordem_exibicao',
                'p.tipo_aplicacao',
                'cp.id as categoria_id',
                'cp.nome as categoria_nome',
                'cp.descricao as categoria_descricao',
                'cp.ordem_exibicao as categoria_ordem_exibicao'
            ])
            .where('p.ativo', true)
            .where('p.disponivel_hoje', true)
            .whereNull('p.deletado_em')
            .where('cp.ativo', true)
            .whereNull('cp.deletado_em');

        if (categoria_id !== undefined) {
            const categoriaId = Number(categoria_id);

            if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
                return next(lancarErro('O filtro categoria_id deve ser um ID válido.', 400));
            }

            query.where('p.categoria_produto_id', categoriaId);
        }

        if (tipoAplicacaoNormalizado) {
            query.where(
                'p.tipo_aplicacao',
                tipoAplicacaoNormalizado
            );
        }

        const produtos = await query
            .orderBy('cp.ordem_exibicao', 'ASC')
            .orderBy('cp.nome', 'ASC')
            .orderBy('p.ordem_exibicao', 'ASC')
            .orderBy('p.nome', 'ASC');

        const categoriasMap = new Map();

        for (const produto of produtos) {
            if (!categoriasMap.has(produto.categoria_id)) {
                categoriasMap.set(produto.categoria_id, {
                    id: produto.categoria_id,
                    nome: produto.categoria_nome,
                    descricao: produto.categoria_descricao,
                    ordem_exibicao: produto.categoria_ordem_exibicao,
                    tipo_aplicacao: produto.tipo_aplicacao,
                    produtos: []
                });
            }

            categoriasMap.get(produto.categoria_id).produtos.push({
                id: produto.id,
                nome: produto.nome,
                descricao: produto.descricao,
                preco: Number(produto.preco),
                ordem_exibicao: produto.ordem_exibicao
            });
        }

        return res.status(200).json({
            status: 'success',
            results: produtos.length,
            data: Array.from(categoriasMap.values())
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * ============================================================
 * LISTAGEM ADMINISTRATIVA
 * ============================================================
 */
export const listarProdutosAdmin = async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            categoria_id,
            tipo_aplicacao,
            status = 'todos',
            disponibilidade = 'todos',
            excluidos = 'false',
            preco_min,
            preco_max,
            sort = 'ordem_exibicao',
            order = 'ASC'
        } = req.query;

        const pageNumber = normalizarInteiroPositivo(page, 1);
        const limitNumber = normalizarInteiroPositivo(limit, 10, 100);
        const offset = (pageNumber - 1) * limitNumber;

        const colunasOrdenacao = {
            id: 'p.id',
            nome: 'p.nome',
            preco: 'p.preco',
            ativo: 'p.ativo',
            disponivel_hoje: 'p.disponivel_hoje',
            categoria: 'cp.nome',
            ordem_exibicao: 'p.ordem_exibicao',
            criado_em: 'p.criado_em',
            atualizado_em: 'p.atualizado_em'
        };

        const colunaOrdenacao = colunasOrdenacao[sort] || 'p.ordem_exibicao';
        const direcao = String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        const query = connection('produtos as p')
            .leftJoin(
                'categorias_produtos as cp',
                'p.categoria_produto_id',
                '=',
                'cp.id'
            );

        if (excluidos === 'false') {
            query.whereNull('p.deletado_em');
        } else if (excluidos === 'true') {
            query.whereNotNull('p.deletado_em');
        }

        if (status === 'ativo') {
            query.where('p.ativo', true);
        } else if (status === 'inativo') {
            query.where('p.ativo', false);
        }

        if (disponibilidade === 'disponivel') {
            query.where('p.disponivel_hoje', true);
        } else if (disponibilidade === 'indisponivel') {
            query.where('p.disponivel_hoje', false);
        }

        if (categoria_id !== undefined && String(categoria_id).trim() !== '') {
            const categoriaId = Number(categoria_id);

            if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
                return next(lancarErro('O filtro categoria_id deve ser um ID válido.', 400));
            }

            query.where('p.categoria_produto_id', categoriaId);
        }

        if (
            tipo_aplicacao !== undefined &&
            String(tipo_aplicacao).trim() !== ''
        ) {
            let tipoAplicacaoNormalizado;

            try {
                tipoAplicacaoNormalizado =
                    normalizarTipoAplicacao(tipo_aplicacao);
            } catch (error) {
                return next(error);
            }

            query.where(
                'p.tipo_aplicacao',
                tipoAplicacaoNormalizado
            );
        }

        if (String(search).trim()) {
            const termo = `%${String(search).trim()}%`;

            query.andWhere(function () {
                this
                    .where('p.nome', 'ILIKE', termo)
                    .orWhere('p.descricao', 'ILIKE', termo)
                    .orWhere('cp.nome', 'ILIKE', termo);
            });
        }

        let minimo = null;
        let maximo = null;

        if (preco_min !== undefined && String(preco_min).trim() !== '') {
            minimo = normalizarPreco(preco_min);
            query.where('p.preco', '>=', minimo);
        }

        if (preco_max !== undefined && String(preco_max).trim() !== '') {
            maximo = normalizarPreco(preco_max);
            query.where('p.preco', '<=', maximo);
        }

        if (minimo !== null && maximo !== null && minimo > maximo) {
            return next(lancarErro('O preço mínimo não pode ser maior que o preço máximo.', 400));
        }

        const totalCount = await query
            .clone()
            .count('p.id as total')
            .first();

        const produtos = await query
            .clone()
            .select([
                'p.id',
                'p.categoria_produto_id',
                'cp.nome as categoria_nome',
                'p.nome',
                'p.descricao',
                'p.preco',
                'p.ativo',
                'p.disponivel_hoje',
                'p.ordem_exibicao',
                'p.criado_em',
                'p.atualizado_em',
                'p.deletado_em',
                'p.tipo_aplicacao'
            ])
            .orderBy(colunaOrdenacao, direcao)
            .orderBy('p.id', 'ASC')
            .limit(limitNumber)
            .offset(offset);

        const total = Number(totalCount?.total || 0);

        return res.status(200).json({
            status: 'success',
            pagination: {
                total,
                page: pageNumber,
                per_page: limitNumber,
                last_page: Math.max(Math.ceil(total / limitNumber), 1)
            },
            data: produtos.map(formatarProdutoParaResposta)
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * ============================================================
 * BUSCAR PRODUTO POR ID
 * ============================================================
 */
export const buscarProdutoPorId = async (req, res, next) => {
    try {
        const { id } = req.params;

        const produto = await connection('produtos as p')
            .leftJoin(
                'categorias_produtos as cp',
                'p.categoria_produto_id',
                '=',
                'cp.id'
            )
            .select([
                'p.id',
                'p.categoria_produto_id',
                'cp.nome as categoria_nome',
                'cp.ativo as categoria_ativa',
                'cp.deletado_em as categoria_deletada_em',
                'p.nome',
                'p.descricao',
                'p.preco',
                'p.ativo',
                'p.disponivel_hoje',
                'p.ordem_exibicao',
                'p.criado_em',
                'p.atualizado_em',
                'p.deletado_em',
                'p.tipo_aplicacao'
            ])
            .where('p.id', id)
            .first();

        if (!produto) {
            return next(lancarErro('Produto não encontrado.', 404));
        }

        return res.status(200).json({
            status: 'success',
            data: formatarProdutoParaResposta(produto)
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * ============================================================
 * CRIAR PRODUTO
 * ============================================================
 */
export const criarProduto = async (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return next(lancarErro('O corpo da requisição não pode estar vazio.', 400));
    }

    const {
        categoria_produto_id,
        nome,
        descricao = null,
        preco,

        tipo_aplicacao = 'PEDIDO',

        ativo = true,
        disponivel_hoje = true,
        ordem_exibicao = 0
    } = req.body;

    const categoriaId = Number(categoria_produto_id);

    if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
        return next(lancarErro('A categoria do produto é obrigatória e deve ser válida.', 400));
    }

    if (!nome || !String(nome).trim()) {
        return next(lancarErro('O nome do produto é obrigatório.', 400));
    }

    let tipoAplicacaoNormalizado;

    try {
        tipoAplicacaoNormalizado =
            normalizarTipoAplicacao(
                tipo_aplicacao,
                'PEDIDO'
            );
    } catch (error) {
        return next(error);
    }

    if (ativo !== undefined && typeof ativo !== 'boolean') {
        return next(lancarErro('O campo ativo deve ser true ou false.', 400));
    }

    if (disponivel_hoje !== undefined && typeof disponivel_hoje !== 'boolean') {
        return next(lancarErro('O campo disponivel_hoje deve ser true ou false.', 400));
    }

    const ordem = Number(ordem_exibicao);

    if (!Number.isInteger(ordem) || ordem < 0) {
        return next(lancarErro('A ordem de exibição deve ser um número inteiro igual ou maior que zero.', 400));
    }

    let precoNormalizado;

    try {
        precoNormalizado = normalizarPreco(preco);
    } catch (error) {
        return next(error);
    }

    const nomeNormalizado = normalizarNome(nome);
    const descricaoNormalizada = descricao === null || descricao === undefined
        ? null
        : String(descricao).trim() || null;

    const disponibilidadeFinal = ativo ? disponivel_hoje : false;
    const trx = await connection.transaction();

    try {
        const categoria = await buscarCategoriaValida(categoriaId, trx);

        if (!categoria) {
            await trx.rollback();
            return next(lancarErro('Categoria de produto inválida, inativa ou removida.', 400));
        }

        // Bloqueia produto de mesmo nome dentro da mesma categoria.
        const produtoExistente = await connection('produtos')
            .transacting(trx)
            .where('categoria_produto_id', categoriaId)
            .whereRaw('LOWER(TRIM(nome)) = LOWER(TRIM(?))', [nomeNormalizado])
            .whereNull('deletado_em')
            .first();

        if (produtoExistente) {
            await trx.rollback();

            return next(
                lancarErro(
                    `Já existe um produto cadastrado com o nome "${nomeNormalizado}" nesta categoria.`,
                    409
                )
            );
        }

        const [novoProduto] = await connection('produtos')
            .transacting(trx)
            .insert({
                categoria_produto_id: categoriaId,
                nome: nomeNormalizado,
                descricao: descricaoNormalizada,
                preco: precoNormalizado,
                tipo_aplicacao: tipoAplicacaoNormalizado,
                ativo,
                disponivel_hoje: disponibilidadeFinal,
                ordem_exibicao: ordem
            })
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'PRODUTO.CRIAR',
                descricao: `Criou o produto #${novoProduto.id}: ${novoProduto.nome}`,
                payload: JSON.stringify({
                    recurso_id: novoProduto.id,
                    categoria: {
                        id: categoria.id,
                        nome: categoria.nome
                    },
                    dados: formatarProdutoParaResposta(novoProduto),
                    contexto: {
                        ip: req.ip,
                        user_agent: req.headers['user-agent']
                    }
                })
            });

        await trx.commit();

        return res.status(201).json({
            status: 'success',
            data: formatarProdutoParaResposta(novoProduto)
        });
    } catch (error) {
        await trx.rollback();

        // Proteção do banco em caso de duas requisições simultâneas.
        if (error.code === '23505') {
            return next(
                lancarErro(
                    `Já existe um produto cadastrado com o nome "${nomeNormalizado}" nesta categoria.`,
                    409
                )
            );
        }

        return next(error);
    }
};

/**
 * ============================================================
 * EDITAR PRODUTO
 * ============================================================
 */
export const editarProduto = async (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return next(lancarErro('O corpo da requisição não pode estar vazio.', 400));
    }

    const { id } = req.params;

    const {
        categoria_produto_id,
        nome,
        descricao,
        preco,
        ativo,
        disponivel_hoje,
        ordem_exibicao
    } = req.body;

    if (nome !== undefined && !String(nome).trim()) {
        return next(lancarErro('O nome do produto não pode ficar vazio.', 400));
    }

    if (ativo !== undefined && typeof ativo !== 'boolean') {
        return next(lancarErro('O campo ativo deve ser true ou false.', 400));
    }

    if (disponivel_hoje !== undefined && typeof disponivel_hoje !== 'boolean') {
        return next(lancarErro('O campo disponivel_hoje deve ser true ou false.', 400));
    }

    if (ordem_exibicao !== undefined) {
        const ordem = Number(ordem_exibicao);

        if (!Number.isInteger(ordem) || ordem < 0) {
            return next(lancarErro('A ordem de exibição deve ser um número inteiro igual ou maior que zero.', 400));
        }
    }

    if (categoria_produto_id !== undefined) {
        const categoriaId = Number(categoria_produto_id);

        if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
            return next(lancarErro('A categoria do produto deve ser um ID válido.', 400));
        }
    }

    let precoNormalizadoRecebido;

    if (preco !== undefined) {
        try {
            precoNormalizadoRecebido = normalizarPreco(preco);
        } catch (error) {
            return next(error);
        }
    }

    const trx = await connection.transaction();
    let nomeFinalParaErro = nome !== undefined ? normalizarNome(nome) : '';

    try {
        const produtoAtual = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .whereNull('deletado_em')
            .forUpdate()
            .first();

        if (!produtoAtual) {
            await trx.rollback();
            return next(lancarErro('Produto não encontrado.', 404));
        }

        const camposParaAtualizar = {};
        let categoriaFinalId = produtoAtual.categoria_produto_id;
        let nomeFinal = produtoAtual.nome;

        // Categoria.
        if (categoria_produto_id !== undefined) {
            const categoriaId = Number(categoria_produto_id);

            if (categoriaId !== produtoAtual.categoria_produto_id) {
                const categoria = await buscarCategoriaValida(categoriaId, trx);

                if (!categoria) {
                    await trx.rollback();

                    return next(
                        lancarErro(
                            'Categoria de produto inválida, inativa ou removida.',
                            400
                        )
                    );
                }

                camposParaAtualizar.categoria_produto_id = categoriaId;
                categoriaFinalId = categoriaId;
            }
        }

        // Nome.
        if (nome !== undefined) {
            const nomeNormalizado = normalizarNome(nome);

            if (nomeNormalizado !== produtoAtual.nome) {
                camposParaAtualizar.nome = nomeNormalizado;
                nomeFinal = nomeNormalizado;
            }
        }

        nomeFinalParaErro = nomeFinal;

        // Verifica duplicidade usando a categoria e nome finais.
        if (
            categoriaFinalId !== produtoAtual.categoria_produto_id ||
            nomeFinal.toLowerCase() !== produtoAtual.nome.toLowerCase()
        ) {
            const duplicado = await connection('produtos')
                .transacting(trx)
                .where('categoria_produto_id', categoriaFinalId)
                .whereRaw('LOWER(TRIM(nome)) = LOWER(TRIM(?))', [nomeFinal])
                .whereNot('id', id)
                .whereNull('deletado_em')
                .first();

            if (duplicado) {
                await trx.rollback();

                return next(
                    lancarErro(
                        `Já existe um produto cadastrado com o nome "${nomeFinal}" nesta categoria.`,
                        409
                    )
                );
            }
        }

        // Descrição.
        if (descricao !== undefined) {
            const descricaoNormalizada = descricao === null
                ? null
                : String(descricao).trim() || null;

            if (descricaoNormalizada !== produtoAtual.descricao) {
                camposParaAtualizar.descricao = descricaoNormalizada;
            }
        }

        // Preço.
        if (
            preco !== undefined &&
            precoNormalizadoRecebido !== Number(produtoAtual.preco)
        ) {
            camposParaAtualizar.preco = precoNormalizadoRecebido;
        }

        // Ordem.
        if (ordem_exibicao !== undefined) {
            const ordem = Number(ordem_exibicao);

            if (ordem !== produtoAtual.ordem_exibicao) {
                camposParaAtualizar.ordem_exibicao = ordem;
            }
        }

        // Ativo.
        if (ativo !== undefined && ativo !== produtoAtual.ativo) {
            camposParaAtualizar.ativo = ativo;

            if (ativo === false) {
                camposParaAtualizar.disponivel_hoje = false;
            }
        }

        // Disponibilidade.
        if (disponivel_hoje !== undefined) {
            const ativoFinal = camposParaAtualizar.ativo !== undefined
                ? camposParaAtualizar.ativo
                : produtoAtual.ativo;

            if (disponivel_hoje === true && ativoFinal === false) {
                await trx.rollback();

                return next(
                    lancarErro(
                        'Um produto inativo não pode ser marcado como disponível hoje.',
                        400
                    )
                );
            }

            if (disponivel_hoje === true) {
                const categoria = await buscarCategoriaValida(
                    categoriaFinalId,
                    trx
                );

                if (!categoria) {
                    await trx.rollback();

                    return next(
                        lancarErro(
                            'Não é possível disponibilizar o produto porque sua categoria está inativa ou removida.',
                            400
                        )
                    );
                }
            }

            if (disponivel_hoje !== produtoAtual.disponivel_hoje) {
                camposParaAtualizar.disponivel_hoje = disponivel_hoje;
            }
        }

        if (Object.keys(camposParaAtualizar).length === 0) {
            await trx.rollback();

            return res.status(200).json({
                status: 'success',
                message: 'Nenhuma alteração necessária, os dados já são os mesmos.',
                data: formatarProdutoParaResposta(produtoAtual)
            });
        }

        const [produtoAtualizado] = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .update(camposParaAtualizar)
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'PRODUTO.EDITAR',
                descricao: `Editou o produto #${id}: ${produtoAtualizado.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    campos_alterados: Object.keys(camposParaAtualizar),
                    dados_antigos: formatarProdutoParaResposta(produtoAtual),
                    dados_novos: formatarProdutoParaResposta(produtoAtualizado),
                    contexto: {
                        ip: req.ip,
                        user_agent: req.headers['user-agent']
                    }
                })
            });

        await trx.commit();

        return res.status(200).json({
            status: 'success',
            data: formatarProdutoParaResposta(produtoAtualizado)
        });
    } catch (error) {
        await trx.rollback();

        if (error.code === '23505') {
            return next(
                lancarErro(
                    `Já existe um produto cadastrado com o nome "${nomeFinalParaErro}" nesta categoria.`,
                    409
                )
            );
        }

        return next(error);
    }
};

/**
 * ============================================================
 * ALTERAR DISPONIBILIDADE
 * ============================================================
 */
export const alternarDisponibilidadeProduto = async (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return next(lancarErro('O corpo da requisição não pode estar vazio.', 400));
    }

    const { id } = req.params;
    const { disponivel_hoje } = req.body;

    if (typeof disponivel_hoje !== 'boolean') {
        return next(lancarErro('O campo disponivel_hoje deve ser true ou false.', 400));
    }

    const trx = await connection.transaction();

    try {
        const produto = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .whereNull('deletado_em')
            .forUpdate()
            .first();

        if (!produto) {
            await trx.rollback();
            return next(lancarErro('Produto não encontrado.', 404));
        }

        if (disponivel_hoje === true) {
            if (!produto.ativo) {
                await trx.rollback();

                return next(
                    lancarErro(
                        'Produto inativo não pode ser disponibilizado para venda.',
                        400
                    )
                );
            }

            const categoria = await buscarCategoriaValida(
                produto.categoria_produto_id,
                trx
            );

            if (!categoria) {
                await trx.rollback();

                return next(
                    lancarErro(
                        'A categoria deste produto está inativa ou removida.',
                        400
                    )
                );
            }
        }

        if (produto.disponivel_hoje === disponivel_hoje) {
            await trx.rollback();

            return res.status(200).json({
                status: 'success',
                message: 'A disponibilidade do produto já está com o valor informado.',
                data: formatarProdutoParaResposta(produto)
            });
        }

        const [produtoAtualizado] = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .update({ disponivel_hoje })
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'PRODUTO.DISPONIBILIDADE',
                descricao: `Alterou a disponibilidade do produto #${id}: ${produto.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    disponivel_anteriormente: produto.disponivel_hoje,
                    disponivel_hoje,
                    contexto: {
                        ip: req.ip,
                        user_agent: req.headers['user-agent']
                    }
                })
            });

        await trx.commit();

        return res.status(200).json({
            status: 'success',
            message: 'Disponibilidade do produto alterada com sucesso.',
            data: formatarProdutoParaResposta(produtoAtualizado)
        });
    } catch (error) {
        await trx.rollback();
        return next(error);
    }
};

/**
 * ============================================================
 * INATIVAR PRODUTO
 * ============================================================
 */
export const inativarProduto = async (req, res, next) => {
    const { id } = req.params;
    const trx = await connection.transaction();

    try {
        const produto = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .whereNull('deletado_em')
            .forUpdate()
            .first();

        if (!produto) {
            await trx.rollback();

            return next(
                lancarErro(
                    'Produto não encontrado ou já removido.',
                    404
                )
            );
        }

        await connection('produtos')
            .transacting(trx)
            .where({ id })
            .update({
                ativo: false,
                disponivel_hoje: false,
                deletado_em: connection.fn.now()
            });

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'PRODUTO.INATIVAR',
                descricao: `Removeu o produto #${id}: ${produto.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    dados_inativados: formatarProdutoParaResposta(produto),
                    contexto: {
                        ip: req.ip,
                        user_agent: req.headers['user-agent']
                    }
                })
            });

        await trx.commit();

        return res.status(200).json({
            status: 'success',
            message: 'Produto removido com sucesso.'
        });
    } catch (error) {
        await trx.rollback();
        return next(error);
    }
};

/**
 * ============================================================
 * REATIVAR PRODUTO
 * ============================================================
 */
export const reativarProduto = async (req, res, next) => {
    const { id } = req.params;
    const trx = await connection.transaction();
    let nomeProduto = '';

    try {
        const produto = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .whereNotNull('deletado_em')
            .forUpdate()
            .first();

        if (!produto) {
            await trx.rollback();

            return next(
                lancarErro(
                    'Produto não encontrado ou já está ativo.',
                    404
                )
            );
        }

        nomeProduto = produto.nome;

        const categoria = await buscarCategoriaValida(
            produto.categoria_produto_id,
            trx
        );

        if (!categoria) {
            await trx.rollback();

            return next(
                lancarErro(
                    'A categoria deste produto está inativa ou removida. Restaure/ative a categoria antes do produto.',
                    409
                )
            );
        }

        const produtoComMesmoNome = await connection('produtos')
            .transacting(trx)
            .where(
                'categoria_produto_id',
                produto.categoria_produto_id
            )
            .whereRaw(
                'LOWER(TRIM(nome)) = LOWER(TRIM(?))',
                [produto.nome]
            )
            .whereNot('id', id)
            .whereNull('deletado_em')
            .first();

        if (produtoComMesmoNome) {
            await trx.rollback();

            return next(
                lancarErro(
                    `Não é possível restaurar o produto "${produto.nome}" porque já existe outro produto com o mesmo nome nesta categoria.`,
                    409
                )
            );
        }

        const [produtoRestaurado] = await connection('produtos')
            .transacting(trx)
            .where({ id })
            .update({
                ativo: true,
                disponivel_hoje: false,
                deletado_em: null
            })
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'PRODUTO.REATIVAR',
                descricao: `Restaurou o produto #${id}: ${produto.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    dados_restaurados: formatarProdutoParaResposta(produtoRestaurado),
                    contexto: {
                        ip: req.ip,
                        user_agent: req.headers['user-agent']
                    }
                })
            });

        await trx.commit();

        return res.status(200).json({
            status: 'success',
            message: 'Produto restaurado com sucesso. Ele permanece indisponível até ser liberado no cardápio.',
            data: formatarProdutoParaResposta(produtoRestaurado)
        });
    } catch (error) {
        await trx.rollback();

        if (error.code === '23505') {
            return next(
                lancarErro(
                    `Não é possível restaurar o produto "${nomeProduto}" porque já existe outro produto com o mesmo nome nesta categoria.`,
                    409
                )
            );
        }

        return next(error);
    }
};