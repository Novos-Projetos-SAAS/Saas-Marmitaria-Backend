import {createHmac} from 'node:crypto';

export function infinitepaySessionCsrf(token,secret) {
    if(typeof token!=='string' || !token || typeof secret!=='string' || !secret) throw new Error('Sessão indisponível.');
    return createHmac('sha256',secret).update('infinitepay-csrf-v1\0'+token).digest('base64url');
}
