import { createHmac, timingSafeEqual } from 'node:crypto';
import connection from '../database/connection.js';
export async function requireActiveFinancialUser(req, res, next) {
    try {
        const user = await connection('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
            .where('u.id',req.usuario.id).where('u.ativo',true).whereNull('u.deletado_em')
            .where('n.ativo',true).select('u.id','n.nome as cargo').first();
        if (!user) return res.status(401).json({ status: 'fail', message: 'Sessão indisponível.' });
        req.usuario = { ...req.usuario, ...user }; // Refresh role before the existing RBAC check.
        next();
    } catch (error) { next(error); }
}
export function csrfToken(req) {
    if (!process.env.JWT_SECRET || !req.cookies?.token) throw new Error('Sessão indisponível.');
    return createHmac('sha256', process.env.JWT_SECRET).update('infinitepay-csrf-v1\0' + req.cookies.token).digest('base64url');
}
export function protectInfinitepayWrite(req, res, next) {
    const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const origin = req.get('Origin');
    const supplied = req.get('X-Infinitepay-CSRF') || '';
    const expected = csrfToken(req);
    const validOrigin = origin && origin !== 'null' && origins.includes(origin);
    const validToken = /^[A-Za-z0-9_-]{43}$/.test(supplied) &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!validOrigin || !validToken) return res.status(403).json({ status: 'fail', message: 'Escrita não autorizada.' });
    if (!req.is('application/json')) return res.status(415).json({ status: 'fail', message: 'Envie JSON.' });
    next();
}
