// src/utils/errorUtils.js

/**
 * Lança um erro padronizado para ser capturado pelo errorHandler
 * @param {string} mensagem - Mensagem de erro para o usuário
 * @param {number} statusCode - Código HTTP (400, 401, 403, 404, etc)
 */
export const lancarErro = (mensagem, statusCode = 400) => {
    const error = new Error(mensagem);
    error.statusCode = statusCode;
    error.exposeMessage = statusCode < 500;
    throw error;
};
