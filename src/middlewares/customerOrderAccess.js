export const orderCookieName = id => `marmitaria_pedido_${id}`;

export function rememberOrderAccess(req, res, id, token) {
    const secure = req.secure || process.env.NODE_ENV === 'production';
    res.cookie(orderCookieName(id), token, {
        httpOnly: true, secure, sameSite: secure ? 'none' : 'lax',
        path: `/pedidos/detalhes/${id}`, maxAge: 30 * 24 * 60 * 60 * 1000
    });
}

export function privateOrderResponse(req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
}
