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

function normalizarDescricao(descricao) {
    if (descricao === undefined) return undefined;
    if (descricao === null) return null;
    if (typeof descricao !== 'string') {
        lancarErro('A descrição deve ser um texto válido.', 400);
    }

    const descricaoFormatada = descricao.trim();

    return descricaoFormatada || null;
}

function normalizarPreco(preco) {
    if (preco === undefined || preco === null || String(preco).trim() === '') {
        lancarErro('O valor da marmita especial é obrigatório.', 400);
    }

    const valor = Number(
        typeof preco === 'string'
            ? preco.replace(',', '.')
            : preco
    );

    if (!Number.isFinite(valor) || valor <= 0) {
        lancarErro('O valor da marmita especial deve ser maior que zero.', 400);
    }

    return Number(valor.toFixed(2));
}

function formatarMarmitaEspecial(marmita) {
    if (!marmita) return marmita;

    return {
        ...marmita,
        preco: Number(marmita.preco)
    };
}

async function buscarMarmitaComMesmoNome(nome, ignorarId = null, trx = null) {
    const query = connection('marmitas_especiais')
        .whereRaw('LOWER(TRIM(nome)) = LOWER(TRIM(?))', [nome])
        .whereNull('deletado_em');

    if (ignorarId !== null) {
        query.whereNot('id', ignorarId);
    }

    if (trx) {
        query.transacting(trx);
    }

    return query.first();
}

/**
 * ============================================================
 * LISTAGEM PÚBLICA
 * ============================================================
 *
 * Retorna somente marmitas especiais ativas.
 */
export const listarMarmitasEspeciais = async (req, res, next) => {
    try {
        const marmitas = await connection('marmitas_especiais')
            .select([
                'id',
                'nome',
                'descricao',
                'preco'
            ])
            .where('ativo', true)
            .whereNull('deletado_em')
            .orderBy('id', 'DESC');

        return res.status(200).json({
            status: 'success',
            results: marmitas.length,
            data: marmitas.map(formatarMarmitaEspecial)
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
export const listarMarmitasEspeciaisAdmin = async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            status = 'todos',
            sort = 'id',
            order = 'DESC'
        } = req.query;

        const pageNumber = normalizarInteiroPositivo(page, 1);
        const limitNumber = normalizarInteiroPositivo(limit, 10, 100);
        const offset = (pageNumber - 1) * limitNumber;

        const colunasOrdenacao = {
            id: 'id',
            nome: 'nome',
            preco: 'preco',
            ativo: 'ativo',
            criado_em: 'criado_em',
            atualizado_em: 'atualizado_em'
        };

        const colunaOrdenacao = colunasOrdenacao[sort] || 'id';
        const direcao = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const query = connection('marmitas_especiais')
            .select([
                'id',
                'nome',
                'descricao',
                'preco',
                'ativo',
                'criado_em',
                'atualizado_em'
            ])
            .whereNull('deletado_em');

        const statusNormalizado = String(status).toLowerCase();

        if (statusNormalizado === 'ativos' || statusNormalizado === 'ativo') {
            query.where('ativo', true);
        } else if (statusNormalizado === 'inativos' || statusNormalizado === 'inativo') {
            query.where('ativo', false);
        }

        const termoBusca = String(search).trim();

        if (termoBusca) {
            query.andWhere(function () {
                this
                    .where('nome', 'ILIKE', `%${termoBusca}%`)
                    .orWhere('descricao', 'ILIKE', `%${termoBusca}%`);
            });
        }

        const countQuery = await query
            .clone()
            .clearSelect()
            .clearOrder()
            .count('id AS total')
            .first();

        const total = Number(countQuery?.total || 0);

        const marmitas = await query
            .orderBy(colunaOrdenacao, direcao)
            .limit(limitNumber)
            .offset(offset);

        return res.status(200).json({
            status: 'success',
            data: marmitas.map(formatarMarmitaEspecial),
            pagination: {
                total,
                page: pageNumber,
                lastPage: Math.max(Math.ceil(total / limitNumber), 1)
            }
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * ============================================================
 * DETALHES
 * ============================================================
 */
export const buscarMarmitaEspecialPorId = async (req, res, next) => {
    try {
        const { id } = req.params;

        const marmita = await connection('marmitas_especiais')
            .where({ id })
            .whereNull('deletado_em')
            .first();

        if (!marmita) {
            return next(lancarErro('Marmita especial não encontrada.', 404));
        }

        return res.status(200).json({
            status: 'success',
            data: formatarMarmitaEspecial(marmita)
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * ============================================================
 * CADASTRO
 * ============================================================
 */
export const criarMarmitaEspecial = async (req, res, next) => {
    let trx;

    try {
        if (!req.body || Object.keys(req.body).length === 0) {
            return next(lancarErro('O corpo da requisição não pode estar vazio.', 400));
        }

        const {
            nome,
            descricao = null,
            preco,
            ativo = true
        } = req.body;

        if (!nome || typeof nome !== 'string' || nome.trim() === '') {
            return next(lancarErro('O nome da marmita especial é obrigatório.', 400));
        }

        if (ativo !== undefined && typeof ativo !== 'boolean') {
            return next(lancarErro('O campo ativo deve ser true ou false.', 400));
        }

        const nomeFormatado = normalizarNome(nome);
        const descricaoFormatada = normalizarDescricao(descricao);
        const precoFormatado = normalizarPreco(preco);

        trx = await connection.transaction();

        const existente = await buscarMarmitaComMesmoNome(
            nomeFormatado,
            null,
            trx
        );

        if (existente) {
            return next(
                lancarErro(
                    `Já existe uma marmita especial cadastrada com o nome "${nomeFormatado}".`,
                    409
                )
            );
        }

        const [novaMarmita] = await connection('marmitas_especiais')
            .transacting(trx)
            .insert({
                nome: nomeFormatado,
                descricao: descricaoFormatada,
                preco: precoFormatado,
                ativo
            })
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: 'MARMITA_ESPECIAL.CRIAR',
                descricao: `Criou a marmita especial #${novaMarmita.id}: ${novaMarmita.nome}`,
                payload: JSON.stringify({
                    recurso_id: novaMarmita.id,
                    dados_criados: formatarMarmitaEspecial(novaMarmita)
                })
            });

        await trx.commit();
        trx = null;

        return res.status(201).json({
            status: 'success',
            message: 'Marmita especial cadastrada com sucesso.',
            data: formatarMarmitaEspecial(novaMarmita)
        });
    } catch (error) {
        if (trx) {
            try {
                await trx.rollback();
            } catch {
                // A transação já pode ter sido encerrada.
            }
        }

        return next(error);
    }
};

/**
 * ============================================================
 * EDIÇÃO
 * ============================================================
 */
export const editarMarmitaEspecial = async (req, res, next) => {
    let trx;

    try {
        if (!req.body || Object.keys(req.body).length === 0) {
            return next(lancarErro('O corpo da requisição não pode estar vazio.', 400));
        }

        const { id } = req.params;
        const {
            nome,
            descricao,
            preco,
            ativo
        } = req.body;

        if (
            nome === undefined &&
            descricao === undefined &&
            preco === undefined &&
            ativo === undefined
        ) {
            return next(lancarErro('Nenhum dado informado para atualização.', 400));
        }

        if (nome !== undefined && (typeof nome !== 'string' || nome.trim() === '')) {
            return next(lancarErro('O nome da marmita especial não pode ficar vazio.', 400));
        }

        if (ativo !== undefined && typeof ativo !== 'boolean') {
            return next(lancarErro('O campo ativo deve ser true ou false.', 400));
        }

        const descricaoFormatada = normalizarDescricao(descricao);
        const precoFormatado = preco === undefined
            ? undefined
            : normalizarPreco(preco);

        trx = await connection.transaction();

        const marmitaAntiga = await connection('marmitas_especiais')
            .transacting(trx)
            .where({ id })
            .whereNull('deletado_em')
            .forUpdate()
            .first();

        if (!marmitaAntiga) {
            return next(lancarErro('Marmita especial não encontrada.', 404));
        }

        const camposParaAtualizar = {};

        if (nome !== undefined) {
            const nomeFormatado = normalizarNome(nome);

            if (nomeFormatado !== marmitaAntiga.nome) {
                const existente = await buscarMarmitaComMesmoNome(
                    nomeFormatado,
                    id,
                    trx
                );

                if (existente) {
                    return next(
                        lancarErro(
                            `Já existe uma marmita especial cadastrada com o nome "${nomeFormatado}".`,
                            409
                        )
                    );
                }

                camposParaAtualizar.nome = nomeFormatado;
            }
        }

        if (
            descricao !== undefined &&
            descricaoFormatada !== marmitaAntiga.descricao
        ) {
            camposParaAtualizar.descricao = descricaoFormatada;
        }

        if (
            preco !== undefined &&
            precoFormatado !== Number(marmitaAntiga.preco)
        ) {
            camposParaAtualizar.preco = precoFormatado;
        }

        if (
            ativo !== undefined &&
            ativo !== marmitaAntiga.ativo
        ) {
            camposParaAtualizar.ativo = ativo;
        }

        if (Object.keys(camposParaAtualizar).length === 0) {
            await trx.rollback();
            trx = null;

            return res.status(200).json({
                status: 'success',
                message: 'Nenhuma alteração necessária, os dados já são os mesmos.',
                data: formatarMarmitaEspecial(marmitaAntiga)
            });
        }

        camposParaAtualizar.atualizado_em = connection.fn.now();

        const [marmitaAtualizada] = await connection('marmitas_especiais')
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
                acao: 'MARMITA_ESPECIAL.EDITAR',
                descricao: `Editou a marmita especial #${id}: ${marmitaAtualizada.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    antes: formatarMarmitaEspecial(marmitaAntiga),
                    depois: formatarMarmitaEspecial(marmitaAtualizada)
                })
            });

        await trx.commit();
        trx = null;

        return res.status(200).json({
            status: 'success',
            message: 'Marmita especial atualizada com sucesso.',
            data: formatarMarmitaEspecial(marmitaAtualizada)
        });
    } catch (error) {
        if (trx) {
            try {
                await trx.rollback();
            } catch {
                // A transação já pode ter sido encerrada.
            }
        }

        return next(error);
    }
};

/**
 * ============================================================
 * ATIVAR / INATIVAR
 * ============================================================
 */
export const alterarStatusMarmitaEspecial = async (req, res, next) => {
    let trx;

    try {
        const { id } = req.params;
        const { ativo } = req.body || {};

        if (typeof ativo !== 'boolean') {
            return next(lancarErro('Informe ativo como true ou false.', 400));
        }

        trx = await connection.transaction();

        const marmita = await connection('marmitas_especiais')
            .transacting(trx)
            .where({ id })
            .whereNull('deletado_em')
            .forUpdate()
            .first();

        if (!marmita) {
            return next(lancarErro('Marmita especial não encontrada.', 404));
        }

        if (marmita.ativo === ativo) {
            await trx.rollback();
            trx = null;

            return res.status(200).json({
                status: 'success',
                message: ativo
                    ? 'A marmita especial já está ativa.'
                    : 'A marmita especial já está inativa.',
                data: formatarMarmitaEspecial(marmita)
            });
        }

        const [marmitaAtualizada] = await connection('marmitas_especiais')
            .transacting(trx)
            .where({ id })
            .update({
                ativo,
                atualizado_em: connection.fn.now()
            })
            .returning('*');

        await connection('logs')
            .transacting(trx)
            .insert({
                tipo: 'ACAO',
                usuario_id: req.usuario.id,
                metodo: req.method,
                endpoint: req.originalUrl,
                acao: ativo
                    ? 'MARMITA_ESPECIAL.ATIVAR'
                    : 'MARMITA_ESPECIAL.INATIVAR',
                descricao: `${ativo ? 'Ativou' : 'Inativou'} a marmita especial #${id}: ${marmita.nome}`,
                payload: JSON.stringify({
                    recurso_id: Number(id),
                    ativo_anterior: marmita.ativo,
                    ativo_atual: ativo
                })
            });

        await trx.commit();
        trx = null;

        return res.status(200).json({
            status: 'success',
            message: ativo
                ? 'Marmita especial ativada com sucesso.'
                : 'Marmita especial inativada com sucesso.',
            data: formatarMarmitaEspecial(marmitaAtualizada)
        });
    } catch (error) {
        if (trx) {
            try {
                await trx.rollback();
            } catch {
                // A transação já pode ter sido encerrada.
            }
        }

        return next(error);
    }
};
