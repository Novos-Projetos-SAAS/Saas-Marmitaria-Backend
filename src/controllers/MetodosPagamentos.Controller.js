import connection from "../database/connection.js";
import { lancarErro } from "../utils/errorUtils.js";

export const listarMetodosDePagamentosAtivos = async (req, res, next) => {

    try {

        const metodos = await connection('metodos_pagamento')
            .where('ativo', true)
            .whereNull('deletado_em')
            .orderBy('nome', 'asc')
            .select('id', 'nome', 'codigo', 'tipo_financeiro')
        
        return res.status(200).json({
            status: 'success',
            data: metodos
        })

    } catch (error) {
        next(error)
    }

}

export const listarTodosMetodosPagamentos = async (req, res, next) => {
    try {
        const metodos = await connection('metodos_pagamento')
            .orderBy('id', 'asc');

        return res.status(200).json({
            status: 'success',
            data: metodos
        });
    } catch (error) {

        next(error);

    }
};

export const criarMetodoPagamento = async (req, res, next) => {
    const { nome } = req.body;
    const usuario_id = req.usuario.id; // ID do Admin logado

    if (!nome) {
        return next(lancarErro('O nome do método de pagamento é obrigatório.', 400));
    }

    const trx = await connection.transaction();

    try {
        const [novoMetodo] = await connection('metodos_pagamento')
            .transacting(trx)
            .insert({ nome, ativo: true })
            .returning('*');

        // Gerando o Log
        await connection('logs').transacting(trx).insert({
            tipo: 'ACAO',
            usuario_id,
            acao: 'METODO_PAGAMENTO.CRIAR',
            descricao: `Admin criou o método de pagamento: ${nome}`,
            payload: JSON.stringify({ novo_metodo: novoMetodo })
        });

        await trx.commit();

        return res.status(201).json({ 
            status: 'success', 
            message: 'Método de pagamento criado com sucesso.',
            data: novoMetodo 
        });
    } catch (error) {
        if (trx) await trx.rollback();
        next(error);
    }
};

export const editarMetodoPagamento = async (req, res, next) => {
    const { id } = req.params;
    const { nome, ativo } = req.body;
    const usuario_id = req.usuario.id;

    const trx = await connection.transaction();

    try {
        const metodo = await connection('metodos_pagamento').where({ id }).first();

        if (!metodo) {
            await trx.rollback();
            return next(lancarErro('Método de pagamento não encontrado.', 404));
        }

        const nomeAtualizado = nome ?? metodo.nome;
        const ativoAtualizado = ativo !== undefined ? ativo : metodo.ativo;

        await connection('metodos_pagamento')
            .transacting(trx)
            .where({ id })
            .update({
                nome: nomeAtualizado,
                ativo: ativoAtualizado,
                atualizado_em: connection.fn.now()
            });

        // Gerando o Log
        await connection('logs').transacting(trx).insert({
            tipo: 'ACAO',
            usuario_id,
            acao: 'METODO_PAGAMENTO.EDITAR',
            descricao: `Admin editou o método de pagamento #${id}`,
            payload: JSON.stringify({ 
                id, 
                antes: { nome: metodo.nome, ativo: metodo.ativo },
                depois: { nome: nomeAtualizado, ativo: ativoAtualizado }
            })
        });

        await trx.commit();

        return res.status(200).json({ status: 'success', message: 'Atualizado com sucesso.' });
    } catch (error) {
        if (trx) await trx.rollback();
        next(error);
    }
};

export const deletarMetodoPagamento = async (req, res, next) => {
    const { id } = req.params;
    const usuario_id = req.usuario.id;

    const trx = await connection.transaction();

    try {
        const metodo = await connection('metodos_pagamento').where({ id }).first();

        if (!metodo) {
            await trx.rollback();
            return next(lancarErro('Método de pagamento não encontrado.', 404));
        }

        // Soft Delete
        await connection('metodos_pagamento')
            .transacting(trx)
            .where({ id })
            .update({
                deletado_em: connection.fn.now(),
                ativo: false 
            });

        // Gerando o Log
        await connection('logs').transacting(trx).insert({
            tipo: 'ACAO',
            usuario_id,
            acao: 'METODO_PAGAMENTO.DELETAR',
            descricao: `Admin excluiu (soft delete) o método de pagamento: ${metodo.nome}`,
            payload: JSON.stringify({ id, nome: metodo.nome })
        });

        await trx.commit();

        return res.status(200).json({ status: 'success', message: 'Método excluído com sucesso.' });
    } catch (error) {
        if (trx) await trx.rollback();
        next(error);
    }
};

export const restaurarMetodoPagamento = async (req, res, next) => {
    const { id } = req.params;
    const usuario_id = req.usuario.id;

    const trx = await connection.transaction();

    try {
        const metodo = await connection('metodos_pagamento')
            .where({ id })
            .first();

        if (!metodo) {
            await trx.rollback();
            return next(lancarErro('Método de pagamento não encontrado.', 404));
        }

        if (metodo.deletado_em === null) {
            await trx.rollback();
            return res.status(400).json({
                status: 'error',
                message: 'Este método de pagamento já está ativo (não está excluído).'
            });
        }

        // Restaura e reativa
        await connection('metodos_pagamento')
            .transacting(trx)
            .where({ id })
            .update({
                deletado_em: null,
                ativo: true
            });

        // Gerando o Log
        await connection('logs').transacting(trx).insert({
            tipo: 'ACAO',
            usuario_id,
            acao: 'METODO_PAGAMENTO.RESTAURAR',
            descricao: `Admin restaurou e reativou o método de pagamento: ${metodo.nome}`,
            payload: JSON.stringify({ id, nome: metodo.nome })
        });

        await trx.commit();

        return res.status(200).json({ 
            status: 'success', 
            message: 'Método de pagamento restaurado e ativado com sucesso.' 
        });

    } catch (error) {
        if (trx) await trx.rollback();
        next(error);
    }
};
