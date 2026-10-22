import connection from '../database/connection.js';
import { encryptApiKey } from '../utils/infinitepayCredentials.js';
import { lancarErro } from '../utils/errorUtils.js';
const fields = new Set(['handle','api_key','remove_api_key','ativo','assured_installments']);
function dto(row) {
    return { handle: row.handle, ativo: false, assured_installments: row.assured_installments,
        has_api_key: row.credencial_atual_id !== null };
}
export async function getInfinitepayConfig() {
    const row = await connection('config_infinitepay').where({ id: 1 }).first('handle','assured_installments','credencial_atual_id');
    if (!row) throw new Error('Configuração financeira indisponível.');
    return dto(row);
}
export async function updateInfinitepayConfig(input, actor) {
    if (!input || Array.isArray(input) || typeof input !== 'object' || !Object.keys(input).length ||
        Object.keys(input).some(key => !fields.has(key))) lancarErro('Configuração inválida.',400);
    if (input.ativo !== undefined && input.ativo !== false) lancarErro('Integração desativada durante a Fase 1.',400);
    if (input.assured_installments !== undefined && (!Number.isInteger(input.assured_installments) ||
        input.assured_installments < 0 || input.assured_installments > 12)) lancarErro('Absorção deve ser um inteiro entre 0 e 12.',400);
    if (input.remove_api_key !== undefined && typeof input.remove_api_key !== 'boolean') lancarErro('Remoção de credencial inválida.',400);
    if (input.remove_api_key && input.api_key !== undefined) lancarErro('Não substitua e remova a chave na mesma operação.',400);
    if (input.api_key !== undefined && (typeof input.api_key !== 'string' || !input.api_key.trim() ||
        input.api_key.length > 4096 || /[\r\n\0]/.test(input.api_key))) lancarErro('Chave inválida.',400);
    let newHandle;
    if (input.handle !== undefined) {
        if (typeof input.handle !== 'string') lancarErro('InfiniteTag inválida.',400);
        newHandle = input.handle.trim().replace(/^\$/, '');
        // Store bounded single-line input; provider-specific syntax is still unhomologated.
        if (!newHandle || newHandle.length > 150 || /[\x00-\x1f\x7f\u2028\u2029]/u.test(newHandle)) lancarErro('InfiniteTag inválida.',400);
    }
    return connection.transaction(async trx => {
        const current = await trx('config_infinitepay').where({ id: 1 }).forUpdate().first();
        if (!current) throw new Error('Configuração financeira indisponível.');
        const handle = newHandle ?? current.handle;
        if (current.credencial_atual_id && handle !== current.handle && input.api_key === undefined && !input.remove_api_key)
            lancarErro('Ao mudar a conta, substitua ou remova explicitamente a chave.',400);
        let credentialId = input.remove_api_key ? null : current.credencial_atual_id;
        if (input.api_key !== undefined) {
            if (!handle) lancarErro('Informe a InfiniteTag antes da chave.',400);
            const envelope = encryptApiKey(input.api_key.trim(), handle);
            const [row] = await trx('infinitepay_credenciais').insert({ handle, ...envelope }).returning('id');
            credentialId = row.id;
        }
        const [saved] = await trx('config_infinitepay').where({ id: 1 }).update({
            handle, ativo: false, credencial_atual_id: credentialId,
            assured_installments: input.assured_installments ?? current.assured_installments,
            atualizado_em: trx.fn.now()
        }).returning(['handle','assured_installments','credencial_atual_id']);
        await trx('logs').insert({
            usuario_id: actor.id, tipo: 'ACAO', metodo: 'PUT', endpoint: '/configuracoes/infinitepay',
            acao: 'INFINITEPAY.CONFIGURAR', descricao: 'Configuração InfinitePay atualizada; integração desativada.',
            payload: JSON.stringify({ campos: Object.keys(input), credencial_substituida: input.api_key !== undefined, credencial_removida: input.remove_api_key === true })
        });
        return dto(saved);
    });
}
