/**
 * Parse Neon-compatible PostgreSQL URLs without leaking them in errors.
 * Financial production creates an explicit verified TLS configuration so that
 * pg-connection-string cannot override ssl.rejectUnauthorized using sslmode.
 */
export function parsePostgresUrl(raw, {financialProduction = false} = {}) {
    let url;
    try { url = new URL(raw); }
    catch { throw new Error('DATABASE_URL inválida.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.pathname || url.pathname === '/' || !url.username || url.hash) {
        throw new Error('DATABASE_URL inválida.');
    }
    const allowed = new Map([['sslmode', new Set(['require', 'verify-full'])], ['channel_binding', new Set(['require'])]]);
    if (financialProduction) {
        for (const [key, value] of url.searchParams) {
            if (!allowed.get(key)?.has(value) || url.searchParams.getAll(key).length !== 1) {
                throw new Error('Parâmetro de conexão PostgreSQL não permitido em produção financeira.');
            }
        }
    }
    const port = Number(url.port || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta PostgreSQL inválida.');
    return {
        host: url.hostname,
        port,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        channelBindingRequired: url.searchParams.get('channel_binding') === 'require'
    };
}

export function financialPostgresConnection(raw, {ca} = {}) {
    const parsed = parsePostgresUrl(raw, {financialProduction: true});
    const {host, port, user, password, database, channelBindingRequired} = parsed;
    return {
        host, port, user, password, database,
        ssl: {rejectUnauthorized: true, ...(ca ? {ca} : {})},
        ...(channelBindingRequired ? {enableChannelBinding: true} : {})
    };
}
