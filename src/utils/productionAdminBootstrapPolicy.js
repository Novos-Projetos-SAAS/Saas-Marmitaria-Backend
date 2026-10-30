import {resolveInfinitepayAdminSeedTarget} from './infinitepayAdminSeedPolicy.js';

/**
 * A production administrator is never created with sample credentials.
 * Require confirmation for both a specific user ID and the creation action.
 */
export function resolveProductionAdminBootstrap(env) {
    const userId=resolveInfinitepayAdminSeedTarget(env);
    if(userId!==1 || env.SEED_PRODUCTION_ADMIN_CONFIRM!=='CRIAR_ADMIN_1') {
        throw new Error('Bootstrap inicial exige o ID 1 e SEED_PRODUCTION_ADMIN_CONFIRM=CRIAR_ADMIN_1.');
    }
    const name=env.SEED_PRODUCTION_ADMIN_NAME?.trim();
    const email=env.SEED_PRODUCTION_ADMIN_EMAIL?.trim().toLowerCase();
    const password=env.SEED_PRODUCTION_ADMIN_PASSWORD;
    if(!name || name.length>100 || /[\x00-\x1f\x7f]/.test(name)) {
        throw new Error('Informe um nome válido em SEED_PRODUCTION_ADMIN_NAME.');
    }
    if(!email || email.length>100 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
        throw new Error('Informe um e-mail válido em SEED_PRODUCTION_ADMIN_EMAIL.');
    }
    if(typeof password!=='string' || password.length<12 || Buffer.byteLength(password,'utf8')>72 ||
       !/[a-z]/.test(password) || !/[A-Z]/.test(password) ||
       !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
        throw new Error('Senha inicial inválida: mínimo 12 caracteres com letras maiúsculas, minúsculas, número e símbolo (até 72 bytes).');
    }
    return {userId,name,email,password};
}
