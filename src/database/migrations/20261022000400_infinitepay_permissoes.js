export async function up(knex) {
    const names = ['pagamentos.configurar','pagamentos.visualizar','pagamentos.conciliar'];
    await knex('permissoes').insert(names.map(nome => ({ nome, descricao: 'InfinitePay: ' + nome }))).onConflict('nome').ignore();
    const admins = await knex('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
        .where('n.nome','admin').where('u.ativo',true).whereNull('u.deletado_em').select('u.id');
    const permissions = await knex('permissoes').whereIn('nome',names).select('id');
    const grants = admins.flatMap(u => permissions.map(p => ({ usuario_id: u.id, permissao_id: p.id })));
    if (grants.length) await knex('permissoes_usuarios').insert(grants).onConflict(['usuario_id','permissao_id']).ignore();
}
export async function down() {
    // Preserve RBAC records/grants that may predate this migration. No destructive permission rollback.
}
