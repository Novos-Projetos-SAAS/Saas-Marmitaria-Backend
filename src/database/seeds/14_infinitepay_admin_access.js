import {
    INFINITEPAY_ADMIN_SEED_PERMISSIONS,
    resolveInfinitepayAdminSeedTarget
} from '../../utils/infinitepayAdminSeedPolicy.js';
import {
    validateProductionEnvironment,
    assertProductionDatabase
} from '../../config/infinitepayProduction.js';

/**
 * Bootstrap one explicitly selected active user as an InfinitePay administrator.
 * Never creates accounts, resets passwords, reactivates deleted users or
 * automatically authorizes any payment capability.
 *
 * Execute ONLY with:
 *   SEED_INFINITEPAY_ADMIN_USER_ID=<ID>
 *   SEED_INFINITEPAY_ADMIN_CONFIRM=PROMOVER_USUARIO_<ID>
 *
 * knex seed:run --specific=14_infinitepay_admin_access.js --env production
 */
export async function seed(knex) {
    const userId=resolveInfinitepayAdminSeedTarget(process.env);

    if(process.env.INFINITEPAY_ENABLED==='true') {
        throw new Error('Desative as capacidades financeiras (INFINITEPAY_ENABLED=false) antes do bootstrap RBAC.');
    }
    if(process.env.NODE_ENV==='production') {
        // Verify deployment identity and TLS before touching real financial RBAC.
        const config=validateProductionEnvironment(process.env);
        await assertProductionDatabase(knex,config);
    }

    await knex.transaction(async trx=>{
        const role=await trx('niveis_acesso')
            .where({nome:'admin',ativo:true}).first('id');
        if(!role) throw new Error('Nível admin ativo não encontrado. A seed não cria nem altera níveis.');

        const user=await trx('usuarios')
            .where({id:userId,ativo:true}).whereNull('deletado_em')
            .forUpdate().first('id','nivel_acesso_id');
        if(!user) throw new Error('Usuário selecionado não existe ou não está ativo. Nenhuma alteração realizada.');

        // The migration is authoritative. Never create production activation
        // permissions in the seed if the corresponding migration was omitted.
        const permissions=await trx('permissoes')
            .whereIn('nome',INFINITEPAY_ADMIN_SEED_PERMISSIONS)
            .select('id','nome');
        const found=new Set(permissions.map(row=>row.nome));
        const missing=INFINITEPAY_ADMIN_SEED_PERMISSIONS.filter(name=>!found.has(name));
        if(missing.length) throw new Error('Catálogo RBAC incompleto: '+missing.join(', ')+'. Aplique as migrations pendentes.');

        if(user.nivel_acesso_id!==role.id) {
            await trx('usuarios').where({id:userId}).update({
                nivel_acesso_id:role.id,atualizado_em:trx.fn.now()
            });
        }
        await trx('permissoes_usuarios')
            .insert(permissions.map(permission=>({
                usuario_id:userId,permissao_id:permission.id
            })))
            .onConflict(['usuario_id','permissao_id']).ignore();
    });

    console.log('Bootstrap InfinitePay: usuário '+userId+
        ' validado como admin com as permissões RBAC necessárias. '+
        'Nenhuma cobrança ou aprovação financeira foi ativada.');
}
