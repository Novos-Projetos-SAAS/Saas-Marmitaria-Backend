// Used only by the explicit Knex test environment; never falls back to DATABASE_URL.
export function isolatedTestConnection(value = process.env.TEST_DATABASE_URL) {
    if (!value) throw new Error('TEST_DATABASE_URL obrigatório para testes PostgreSQL isolados.');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/infinitepay_[a-z0-9_]*test$/.test(url.pathname) || url.search || url.hash) {
        throw new Error('Conexão de teste recusada: use loopback e banco infinitepay_*test.');
    }
    const schema = process.env.TEST_DATABASE_SCHEMA;
    if (schema && !/^iptest_[a-f0-9]{32}$/.test(schema)) throw new Error('Schema de teste inválido.');
    return { host: url.hostname.replaceAll('[','').replaceAll(']',''), port: Number(url.port || 5432),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: url.pathname.slice(1), ssl: false,
        ...(schema ? { options: '-c search_path=' + schema } : {}) };
}
