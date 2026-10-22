import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyFor(version) {
    try {
        const ring = process.env.INFINITEPAY_ENCRYPTION_KEYS ? JSON.parse(process.env.INFINITEPAY_ENCRYPTION_KEYS) : {};
        const encoded = ring[String(version)] ?? (version === 1 ? process.env.INFINITEPAY_ENCRYPTION_KEY : undefined);
        if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error();
        const key = Buffer.from(encoded, 'base64');
        if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
        return key;
    } catch { throw new Error('Configuração de criptografia indisponível.'); }
}
function context(handle) {
    if (typeof handle !== 'string' || !handle) throw new Error('Contexto de credencial inválido.');
    return Buffer.from('infinitepay:credential:v1:' + handle, 'utf8');
}
export function encryptApiKey(plaintext, handle) {
    const version = Number(process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION || 1);
    if (!Number.isInteger(version) || version < 1 || version > 32767) throw new Error('Versão de criptografia inválida.');
    if (typeof plaintext !== 'string' || plaintext.length < 1 || plaintext.length > 4096 || /[\r\n\0]/.test(plaintext)) throw new Error('Credencial inválida.');
    const key = keyFor(version);
    try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(context(handle));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return { api_key_ciphertext: ciphertext.toString('base64'), api_key_iv: iv.toString('base64'),
            api_key_tag: cipher.getAuthTag().toString('base64'), key_version: version };
    } finally { key.fill(0); }
}
export function decryptApiKey(envelope, handle) {
    const key = keyFor(Number(envelope.key_version));
    try {
        const iv = Buffer.from(envelope.api_key_iv, 'base64');
        const tag = Buffer.from(envelope.api_key_tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(context(handle));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(envelope.api_key_ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('Não foi possível abrir a credencial.'); }
    finally { key.fill(0); }
}
