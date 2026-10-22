const PUBLIC_CONFLICTS = new Set(['ALIMENTOS_INDISPONIVEIS', 'PRODUTOS_INDISPONIVEIS', 'PRODUTOS_ALTERADOS', 'MARMITAS_ESPECIAIS_ALTERADAS', 'LOJA_FECHADA']);
const DETAIL_KEYS = new Set(['marmitas', 'marmitas_especiais', 'produtos', 'alimentos', 'marmita_index', 'tamanho_id', 'tamanho_nome', 'id', 'nome', 'tipo', 'motivo', 'preco_anterior', 'preco_atual', 'descricao_atual', 'categoria_id', 'categoria_nome']);
function publicDetails(value, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(value)) return value.slice(0, 500).map(item => publicDetails(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => DETAIL_KEYS.has(key)).map(([key, item]) => [key, publicDetails(item, depth + 1)]));
    return typeof value === 'string' ? value.slice(0, 1000) : value;
}
// Whitelist metadata; never copy body, headers, full URL, error.message or stack.
export function safeRequestLog(req = {}) {
    const route = typeof req.route?.path === 'string' ? req.route.path : null;
    return {
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'UNKNOWN',
        route: route ? String(req.baseUrl || '') + route : '[unmatched]',
        usuario_id: Number.isSafeInteger(req.usuario?.id) ? req.usuario.id : null
    };
}
export function publicError(error = {}) {
    const internal = !Number.isInteger(error.statusCode) || error.statusCode >= 500;
    const conflict = error.exposeDetails === true && PUBLIC_CONFLICTS.has(error.code);
    const message = internal ? 'Erro interno no servidor' : error.exposeMessage === true || conflict ? error.message : 'Não foi possível processar a solicitação.';
    const result = { status: internal ? 'error' : 'fail', message };
    if (conflict) { result.code = error.code; if (error.details) result.details = publicDetails(error.details); }
    return result;
}
