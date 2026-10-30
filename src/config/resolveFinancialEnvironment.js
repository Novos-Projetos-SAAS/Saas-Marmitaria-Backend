/**
 * Optional deployment conventions. Values explicitly supplied by the operator
 * always win. This function never enables a payment capability.
 */
export function resolveFinancialEnvironment(input = process.env) {
    if (input.NODE_ENV !== 'production' || input.INFINITEPAY_MODE !== 'production') return {...input};
    const env = {...input};
    const derive = (key, value) => {
        if ((env[key] === undefined || env[key] === '') && typeof value === 'string' && value) env[key] = value;
    };
    if (env.DATABASE_URL && !env.INFINITEPAY_DATABASE_NAME) {
        // The connection parser performs the security checks; only extract its database name.
        const databaseUrl = new URL(env.DATABASE_URL);
        derive('INFINITEPAY_DATABASE_NAME', decodeURIComponent(databaseUrl.pathname.slice(1)));
    }
    derive('INFINITEPAY_PUBLIC_ORIGIN', env.BACKEND_URL || (env.RENDER === 'true' ? env.RENDER_EXTERNAL_URL : undefined));
    if (env.FRONTEND_URL) {
        // Do not silently accept invalid frontend URLs; production validation checks HTTPS.
        const frontend = new URL(env.FRONTEND_URL).origin;
        derive('INFINITEPAY_SUCCESS_URL', frontend + '/pedido/sucesso');
        derive('ALLOWED_ORIGINS', frontend);
        if (env.INFINITEPAY_PUBLIC_ORIGIN) {
            derive('INFINITEPAY_ALLOWED_PUBLIC_ORIGINS', [env.INFINITEPAY_PUBLIC_ORIGIN, frontend].join(','));
        }
    }
    if (env.RENDER === 'true') derive('INFINITEPAY_BIND_HOST', '0.0.0.0');
    // One optional master switch replaces four repetitive Render settings.
    // The switch only exposes capabilities for independent, explicit and
    // expiring administrative authorization; it never creates authorization.
    const switches = ['INFINITEPAY_CHECKOUT_ENABLED','INFINITEPAY_WORKER_ENABLED',
        'INFINITEPAY_VERIFY_ENABLED','INFINITEPAY_DELIVERY_ENABLED'];
    if (env.INFINITEPAY_ENABLED !== undefined && !['true','false',''].includes(env.INFINITEPAY_ENABLED)) {
        throw new Error('INFINITEPAY_ENABLED inválido.');
    }
    if (env.INFINITEPAY_ENABLED === 'false') {
        for (const name of switches) env[name] = 'false';
    } else if (env.INFINITEPAY_ENABLED === 'true') {
        for (const name of switches) derive(name, 'true');
    }
    return env;
}
