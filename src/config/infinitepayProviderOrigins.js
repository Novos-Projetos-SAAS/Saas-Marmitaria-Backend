export function providerOrigins(env = process.env) {
    if (env.INFINITEPAY_DEMO && env.INFINITEPAY_DEMO !== 'local-only') throw new Error('Perfil de demonstração desconhecido.');
    if (env.INFINITEPAY_DEMO === 'local-only') {
        if (env.NODE_ENV !== 'development' || env.INFINITEPAY_MODE !== 'homologation' ||
            env.DB_HOST !== '127.0.0.1' || String(env.DB_PORT) !== '55439' ||
            env.DB_NAME !== 'infinitepay_phase1_test' || env.INFINITEPAY_DATABASE_NAME !== env.DB_NAME || env.DATABASE_URL)
            throw new Error('Demonstração recusada: perfil local exclusivo obrigatório.');
        return { demo:true, checkoutOrigin:'https://localhost:55446', receiptOrigin:'https://localhost:55446' };
    }
    return { demo:false, checkoutOrigin:'https://checkout.infinitepay.io', receiptOrigin:'https://recibo.infinitepay.io' };
}
