import chalk from 'chalk';
import logSymbols from 'log-symbols';
import connection from '../database/connection.js';

export default async function errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || err.status || 500;
    const financialRequest = /^\/(pagamentos|configuracoes\/infinitepay|webhooks\/infinitepay)(\/|$)/.test(req.path);
    const message = financialRequest && statusCode >= 500
        ? 'Não foi possível concluir a operação de pagamento. Confira a configuração ou tente conciliar novamente.'
        : err.message || 'Erro interno no servidor';
    const endpoint = financialRequest ? req.path : req.originalUrl;
    const status = statusCode >= 500 ? 'error' : 'fail';
    const timestamp = new Date().toISOString();

    const resposta = { status, message };

    // Apenas erros estruturados e explicitamente liberados expõem código e detalhes para o Frontend.
    if (err.exposeDetails === true && err.code) resposta.code = err.code;
    if (err.exposeDetails === true && err.details) resposta.details = err.details;

    // Erros de regra de negócio são esperados e não representam falha interna do sistema.
    if (statusCode < 500) {
        if (statusCode === 409) {
            console.warn(`${logSymbols.warning} ${chalk.yellow(`[${timestamp}] Conflito em ${req.method} ${req.originalUrl}: ${message}`)}`);
        }

        return res.status(statusCode).json(resposta);
    }

    // Somente erros internos reais são registrados como erro no terminal e no banco.
    console.error(`\n${logSymbols.error} ${chalk.red(`[${timestamp}] Erro em ${req.method} ${endpoint}`)}`);
    console.error(chalk.red(`Mensagem: ${message}`));
    if (!financialRequest) console.error(chalk.red(err.stack));
    console.error(chalk.gray('--------------------------------------------------\n'));

    try {
        await connection('logs').insert({
            tipo: 'ERRO',
            usuario_id: req.usuario?.id || null,
            metodo: req.method,
            endpoint,
            acao: 'SISTEMA.ERRO',
            descricao: message,
            payload: JSON.stringify({
                code: err.code || null,
                details: financialRequest ? null : err.details || null,
                stack: financialRequest || process.env.NODE_ENV === 'production' ? '🔒' : err.stack,
                body: financialRequest ? '[REDACTED]' : req.body,
                params: req.params,
                query: financialRequest ? '[REDACTED]' : req.query
            })
        });
    } catch (dbError) {
        console.error(`${logSymbols.warning} ${chalk.yellow('Falha ao gravar log de erro no banco:')} ${dbError.message}`);
    }

    return res.status(statusCode).json(resposta);
}
