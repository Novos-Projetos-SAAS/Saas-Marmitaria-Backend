import connection from '../database/connection.js';
import { encryptApiKey, decryptApiKey } from '../utils/infinitepayCredentials.js';
import { lancarErro } from '../utils/errorUtils.js';

export async function getInfinitepayConfig(db = connection, { lock = false } = {}) {
    const query = db('config_infinitepay').where({ id: 1 });
    if (lock) query.forShare();
    const config = await query.first();
    if (!config) lancarErro('Configuração InfinitePay indisponível.', 503);
    return config;
}

export function publicConfig(config) {
    return { handle: config.handle, ativo: config.ativo, assured_installments: config.assured_installments,
        pix_habilitado: config.pix_habilitado, credito_habilitado: config.credito_habilitado,
        has_api_key: config.credencial_atual_id !== null };
}

export async function readPublicConfig(db = connection) {
    return publicConfig(await getInfinitepayConfig(db));
}

export async function getPaymentCredential(credentialId, db = connection) {
    const credential = await db('infinitepay_credenciais').where({ id: credentialId }).first();
    if (!credential) lancarErro('Credencial InfinitePay não encontrada.', 503);
    return { id: credential.id, handle: credential.handle, apiKey: decryptApiKey(credential, credential.handle) };
}

function validateObject(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length ||
        Object.keys(input).some(key => !allowed.includes(key))) lancarErro('Configuração inválida.', 400);
}

export async function updateInfinitepayConfig(input, db = connection) {
    validateObject(input, ['handle', 'api_key', 'assured_installments', 'pix_habilitado', 'credito_habilitado']);
    for (const field of ['pix_habilitado', 'credito_habilitado']) {
        if (Object.hasOwn(input, field) && typeof input[field] !== 'boolean') lancarErro('Preferência de pagamento inválida.', 400);
    }
    let handle;
    if (input.handle !== undefined) {
        if (typeof input.handle !== 'string') lancarErro('InfiniteTag inválida.', 400);
        handle = input.handle.trim().replace(/^\$/, '');
        if (!handle || handle.length > 150 || /[\s\x00-\x1f\x7f]/u.test(handle)) lancarErro('InfiniteTag inválida.', 400);
    }
    if (input.api_key !== undefined && (typeof input.api_key !== 'string' || !input.api_key.trim() ||
        input.api_key.length > 4096 || !/^[\x21-\x7e]+$/.test(input.api_key.trim()))) lancarErro('API Key inválida.', 400);
    if (input.assured_installments !== undefined && (!Number.isInteger(input.assured_installments) ||
        input.assured_installments < 0 || input.assured_installments > 12)) lancarErro('Parcelas devem estar entre 0 e 12.', 400);
    return db.transaction(async trx => {
        const current = await trx('config_infinitepay').where({ id: 1 }).forUpdate().first();
        if (!current) lancarErro('Configuração InfinitePay indisponível.', 503);
        const nextHandle = handle ?? current.handle;
        if (current.credencial_atual_id && nextHandle !== current.handle && input.api_key === undefined) {
            lancarErro('Ao alterar a InfiniteTag, informe novamente a API Key.', 400);
        }
        let credentialId = current.credencial_atual_id;
        if (input.api_key !== undefined) {
            if (!nextHandle) lancarErro('Informe a InfiniteTag antes da API Key.', 400);
            const [created] = await trx('infinitepay_credenciais').insert({
                config_id: 1, handle: nextHandle, ...encryptApiKey(input.api_key.trim(), nextHandle)
            }).returning('id');
            credentialId = created.id;
        }
        const [saved] = await trx('config_infinitepay').where({ id: 1 }).update({ handle: nextHandle,
            credencial_atual_id: credentialId, assured_installments: input.assured_installments ?? current.assured_installments,
            pix_habilitado: input.pix_habilitado ?? current.pix_habilitado,
            credito_habilitado: input.credito_habilitado ?? current.credito_habilitado,
            atualizado_em: trx.fn.now() }).returning('*');
        return publicConfig(saved);
    });
}

export async function setInfinitepayActivation(input, db = connection) {
    validateObject(input, ['ativo']);
    if (typeof input.ativo !== 'boolean') lancarErro('Ativação inválida.', 400);
    return db.transaction(async trx => {
        const config = await trx('config_infinitepay').where({ id: 1 }).forUpdate().first();
        if (!config) lancarErro('Configuração InfinitePay indisponível.', 503);
        if (input.ativo) {
            if (!config.handle || !config.credencial_atual_id) lancarErro('Cadastre a InfiniteTag e a API Key antes de ativar.', 400);
            const credential = await getPaymentCredential(config.credencial_atual_id, trx);
            if (credential.handle !== config.handle) lancarErro('A credencial não corresponde à InfiniteTag.', 400);
        }
        const [saved] = await trx('config_infinitepay').where({ id: 1 }).update({
            ativo: input.ativo, atualizado_em: trx.fn.now()
        }).returning('*');
        return publicConfig(saved);
    });
}
