// Financial permissions need a fresh administrator-role check on the server
// when they are added or removed. UI-only checks are never sufficient.
export const FINANCIAL_PRIVILEGED_PERMISSIONS = Object.freeze([
    'pagamentos.configurar',
    'pagamentos.conciliar',
    'pagamentos.ativar_producao'
]);

export function changedFinancialPrivileges(currentNames, nextNames) {
    const current=new Set(currentNames);
    const next=new Set(nextNames);
    return FINANCIAL_PRIVILEGED_PERMISSIONS.filter(name=>current.has(name)!==next.has(name));
}
