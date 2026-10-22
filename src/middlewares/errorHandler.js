import connection from '../database/connection.js';
import { publicError, safeRequestLog } from '../utils/safeRequestLog.js';
export default async function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500;
    const response = publicError({ ...err, message: err.message, statusCode });
    const record = safeRequestLog(req);
    if (statusCode === 409) console.warn('Conflito na API', record);
    if (statusCode >= 500) {
        console.error('Erro interno na API', record);
        try {
            await connection('logs').insert({
                tipo: 'ERRO', usuario_id: record.usuario_id, metodo: record.method,
                endpoint: record.route, acao: 'SISTEMA.ERRO', descricao: 'Erro interno no servidor',
                payload: JSON.stringify({ statusCode })
            });
        } catch { console.error('Falha ao gravar auditoria de erro'); }
    }
    return res.status(statusCode).json(response);
}
