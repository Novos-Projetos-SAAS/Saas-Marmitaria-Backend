import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const privateDirectory=fileURLToPath(new URL('../../../infinitepay-credit-private/',import.meta.url));
export function validateCreditProfile(profile) {
    if(profile?.purpose!=='INFINITEPAY_CREDIT_PREPARATION_ONLY' || profile.host!=='127.0.0.1' || profile.port!==55439 ||
        profile.database!=='infinitepay_credit_homologacao' || profile.user!=='codex_test' || profile.checkoutEnabled===true ||
        typeof profile.encryptionKey!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(profile.encryptionKey) || Buffer.from(profile.encryptionKey,'base64').length!==32) {
        throw new Error('Perfil exclusivo de Crédito recusado.');
    }
    return profile;
}
export async function loadCreditProfile() {
    return validateCreditProfile(JSON.parse((await readFile(privateDirectory+'profile.json','utf8')).replace(/^\uFEFF/,'')));
}
