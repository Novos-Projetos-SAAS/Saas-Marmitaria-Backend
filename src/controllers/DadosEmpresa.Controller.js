import connection from "../database/connection.js";
import { isValidCPF, isValidCNPJ } from "../utils/validators.js";
const companyFields = ['nome_proprietario','cpf_proprietario','telefone_proprietario','razao_social','nome_fantasia',
    'cnpj','telefone_empresa','email_empresa','logo_url','cep','logradouro','numero','complemento','bairro','cidade',
    'estado','imprimir_automaticamente','nome_impressora'];

export const buscarDadosEmpresa = async (req, res, next) => {
    try {
        // Busca sempre o registro principal (ID 1)
        const empresa = await connection('dados_empresa').where('id', 1).first();

        return res.status(200).json({
            status: 'success',
            data: empresa || null // Retorna null se ainda não houver cadastro
        });
    } catch (error) {
        next(error);
    }
};

export const buscarDadosEmpresaPublicos = async (req, res, next) => {
    try {
        const empresa = await connection('dados_empresa')
            .where('id', 1)
            .first(
                'id',
                'nome_fantasia',
                'telefone_empresa',        
                'email_empresa',
                'logradouro',
                'numero',
                'complemento',
                'bairro',
                'cidade',
                'estado',
                'cep',
            );

        return res.status(200).json({
            status: 'success',
            data: empresa || null
        });
    } catch (error) {
        next(error);
    }
};

export const salvarDadosEmpresa = async (req, res, next) => {
    const body = req.body || {};
    const allowed = new Set([...companyFields, 'id', 'criado_em', 'atualizado_em']);
    if (Object.keys(body).some(key => !allowed.has(key))) {
        return res.status(400).json({ status: 'fail', message: 'Campo de configuração não permitido.' });
    }
    // Legacy forms send id/timestamps back; ignore these server-owned fields.
    const dados = Object.fromEntries(Object.entries(body).filter(([key]) => companyFields.includes(key)));
    const usuarioId = req.usuario?.id || null;

    if (dados.cnpj && dados.cnpj.trim() !== "") {
        if (!isValidCNPJ(dados.cnpj)) {
            return res.status(400).json({
                status: 'error',
                message: 'O CNPJ informado é inválido.'
            });
        }
    }

    if (dados.cpf_proprietario && dados.cpf_proprietario.trim() !== "") {
        if (!isValidCPF(dados.cpf_proprietario)) {
            return res.status(400).json({
                status: 'error',
                message: 'O CPF do proprietário informado é inválido.'
            });
        }
    }

    try {
        const empresaExistente = await connection('dados_empresa').where('id', 1).first();

        const payload = {
            ...dados,
            atualizado_em: connection.fn.now()
        };

        let empresaRetorno;
        let logAcao;
        let logDescricao;
        let statusCode;
        let mensagemSucesso;

        if (empresaExistente) {
            // Se já existe, faz o UPDATE
            const [empresaAtualizada] = await connection('dados_empresa')
                .where('id', 1)
                .update(payload)
                .returning('*');

            empresaRetorno = empresaAtualizada;
            logAcao = 'ATUALIZAR_EMPRESA';
            logDescricao = 'Configurações da empresa atualizadas.';
            statusCode = 200;
            mensagemSucesso = 'Dados da empresa atualizados com sucesso.';
        } else {
            // Se não existe, cria (INSERT)
            delete payload.atualizado_em;

            const [novaEmpresa] = await connection('dados_empresa')
                .insert({ ...payload, id: 1 })
                .returning('*');

            empresaRetorno = novaEmpresa;
            logAcao = 'CADASTRAR_EMPRESA';
            logDescricao = 'Configurações da empresa cadastradas.';
            statusCode = 201;
            mensagemSucesso = 'Dados da empresa cadastrados com sucesso.';
        }

        // 📝 REGISTRO DE AUDITORIA (LOGS)
        await connection('logs').insert({
            usuario_id: usuarioId,
            acao: logAcao,
            descricao: logDescricao,
            tipo: 'ACAO',
            metodo: req.method,
            endpoint: '/configuracoes/empresa',
            payload: JSON.stringify({ campos: Object.keys(dados) })
        });

        // Retorno final para o Frontend
        return res.status(statusCode).json({
            status: 'success',
            message: mensagemSucesso,
            data: empresaRetorno
        });

    } catch (error) {
        next(error);
    }
};
