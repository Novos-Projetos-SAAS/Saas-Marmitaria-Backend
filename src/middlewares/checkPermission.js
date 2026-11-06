import connection from "../database/connection.js";

export const checkPermission = (permissaoRequerida) => {

    return async (req, res, next) => {
        try {

            const usuarioId = req.usuario?.id;

            const usuarioCargo = req.usuario?.cargo;

            if (usuarioCargo === 'admin') {
                return next();
            }

            const temPermissao = await connection('permissoes_usuarios')
                .join('permissoes', 'permissoes_usuarios.permissao_id', '=', 'permissoes.id')
                .where('permissoes_usuarios.usuario_id', usuarioId)
                .whereIn('permissoes.nome', Array.isArray(permissaoRequerida) ? permissaoRequerida : [permissaoRequerida])
                .first();

            if (!temPermissao) {
                return res.status(403).json({
                    status: 'fail',
                    message: `Acesso negado: você não possui a permissão para esta ação.`
                });
            }

            return next();

        } catch (error) {
            // console.error('🔴 Erro no Middleware de Permissão:', error);
            // return res.status(500).json({
            //     status: 'error',
            //     message: 'Erro interno ao validar permissões.'
            // });
        
            next(error);
        }
    }
}