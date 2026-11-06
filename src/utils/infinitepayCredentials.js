import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey() {
    const encoded = process.env.INFINITEPAY_ENCRYPTION_KEY;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
        throw new Error('INFINITEPAY_ENCRYPTION_KEY deve conter uma chave de 32 bytes em Base64.');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
        throw new Error('Chave de criptografia InfinitePay inválida.');
    }
    return key;
}

function context(handle) {
    if (typeof handle !== 'string' || !handle) throw new Error('InfiniteTag da credencial inválida.');
    return Buffer.from('infinitepay:credential:v1:' + handle, 'utf8');
}

export function encryptApiKey(plaintext, handle) {
    const key = encryptionKey();
    try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(context(handle));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return { api_key_ciphertext: ciphertext.toString('base64'), api_key_iv: iv.toString('base64'),
            api_key_tag: cipher.getAuthTag().toString('base64'), key_version: 1 };
    } finally { key.fill(0); }
}

export function decryptApiKey(envelope, handle) {
    if (Number(envelope.key_version) !== 1) {
        throw new Error('Credencial antiga usa outra versão de chave. Cadastre novamente a API Key.');
    }
    const key = encryptionKey();
    try {
        const iv = Buffer.from(envelope.api_key_iv, 'base64');
        const tag = Buffer.from(envelope.api_key_tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(context(handle));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(envelope.api_key_ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('Não foi possível abrir a credencial InfinitePay. Verifique a chave de criptografia ou cadastre novamente a API Key.'); }
    finally { key.fill(0); }
}
