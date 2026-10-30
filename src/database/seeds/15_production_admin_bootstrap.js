import {hashPassword} from '../../utils/passwordUtils.js';
import {resolveProductionAdminBootstrap} from '../../utils/productionAdminBootstrapPolicy.js';
import {BASE_RBAC_PERMISSIONS} from './02_RBAC_permissoes.js';
import {validateProductionEnvironment,assertProductionDatabase} from '../../config/infinitepayProduction.js';

/**
 * One-time, non-destructive production bootstrap for an EMPTY database.
 * NEVER recreates existing accounts or resets a password.
 * Requires explicit operator-selected credentials and confirmation.
 *
 * Run as a specific seed, never with the legacy full seed runner.
 */
export async function seed(knex) {
    if(process.env.NODE_ENV!=='production' || process.env.INFINITEPAY_MODE!=='production' ||
        process.env.INFINITEPAY_ENABLED!=='false') {
        throw new Error('Bootstrap inicial requer perfil production e INFINITEPAY_ENABLED=false.');
    }
    const target=resolveProductionAdminBootstrap(process.env);
    const environment=validateProductionEnvironment(process.env);
    await assertProductionDatabase(knex,environment);

    await knex.transaction(async trx=>{
        // Protect the empty-database check from concurrent registrations.
        await trx.raw('LOCK TABLE usuarios IN EXCLUSIVE MODE');
        if(await trx('usuarios').first('id')) {
            throw new Error('O banco já possui usuário(s). Bootstrap inicial negado para preservar contas.');
        }
        for(const table of ['pedidos','pagamentos','infinitepay_autorizacoes_producao']) {
            if(await trx(table).first('id')) {
                throw new Error('O banco contém registros operacionais/financeiros. Bootstrap inicial negado.');
            }
        }
        const roles=[
            {nome:'admin',descricao:'Administrador do sistema',ativo:true},
            {nome:'atendente',descricao:'Atendimento e pedidos',ativo:true},
            {nome:'entregador',descricao:'Operações de entrega',ativo:true}
        ];
        await trx('niveis_acesso').insert(roles).onConflict('nome').ignore();
        const adminRole=await trx('niveis_acesso').where({nome:'admin',ativo:true}).first('id');
        if(!adminRole) throw new Error('Não há nível administrativo ativo.');

        // Migrations create the financial permission catalog. This list is the
        // legacy non-financial RBAC catalog without its destructive seed logic.
        await trx('permissoes').insert(BASE_RBAC_PERMISSIONS)
            .onConflict('nome').ignore();
        const hashed=await hashPassword(target.password);
        const [admin]=await trx('usuarios').insert({
            nome:target.name,email:target.email,senha_hash:hashed,
            nivel_acesso_id:adminRole.id,ativo:true
        }).returning('id');
        if(admin.id!==target.userId) {
            throw new Error('ID gerado é diferente do usuário confirmado. Bootstrap cancelado.');
        }
        const baseNames=BASE_RBAC_PERMISSIONS.map(row=>row.nome);
        const grants=await trx('permissoes').whereIn('nome',baseNames).select('id');
        if(grants.length!==baseNames.length) throw new Error('Catálogo base incompleto.');
        await trx('permissoes_usuarios').insert(grants.map(row=>({
            usuario_id:admin.id,permissao_id:row.id
        }))).onConflict(['usuario_id','permissao_id']).ignore();
    });

    console.info('Bootstrap inicial concluído: usuário administrador ID 1 criado com senha fornecida pelo operador. '+
        'Execute a seed 14 específica para conceder os dois acessos InfinitePay. Pagamentos continuam desabilitados.');
}
