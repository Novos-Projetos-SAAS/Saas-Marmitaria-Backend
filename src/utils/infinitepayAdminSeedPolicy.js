/**
 * Explicit, one-user RBAC bootstrap for InfinitePay.
 *
 * A seed may only elevate an account when the operator selects its exact ID
 * and confirms that ID. Never default to user #1 or all admins.
 */
export const INFINITEPAY_ADMIN_SEED_PERMISSIONS = Object.freeze([
    'permissoes.listar',
    'permissoes.visualizar',
    'permissoes.editar',
    'pagamentos.configurar',
    'pagamentos.visualizar',
    'pagamentos.conciliar',
    'pagamentos.ativar_producao'
]);

export function resolveInfinitepayAdminSeedTarget(env) {
    const input=env?.SEED_INFINITEPAY_ADMIN_USER_ID;
    if(typeof input!=='string' || !/^[1-9]\d{0,14}$/.test(input)) {
        throw new Error('Informe SEED_INFINITEPAY_ADMIN_USER_ID com o ID do usuário administrador.');
    }
    const userId=Number(input);
    if(!Number.isSafeInteger(userId) || userId<=0 ||
        env.SEED_INFINITEPAY_ADMIN_CONFIRM !== 'PROMOVER_USUARIO_'+userId) {
        throw new Error('Confirmação de promoção inválida. Use SEED_INFINITEPAY_ADMIN_CONFIRM=PROMOVER_USUARIO_<ID>.');
    }
    return userId;
}
