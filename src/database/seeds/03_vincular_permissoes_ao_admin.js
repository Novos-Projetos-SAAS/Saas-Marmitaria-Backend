/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
import chalk from 'chalk';
import logSymbols from 'log-symbols';

export async function seed(knex) {

    const admins = await knex('usuarios')
        .where({
            nivel_acesso_id: 1, // ID do nível de acesso "admin"
            deletado_em: null
        })

    // Assinatura QZ e aprovação de produção InfinitePay exigem concessão
    // individual explícita, inclusive para administradores.
    const permissoes = await knex('permissoes')
        .whereNotIn('nome', ['impressao.assinar', 'pagamentos.ativar_producao']).select('id');

    if (admins.length == 0 || permissoes.length == 0) {
        console.log(logSymbols.warning, chalk.yellow('Nenhum admin ou permissão encontrada para vincular.'));
        return;
    }

    const vinculosParaInserir = [];

    for (const admin of admins) {

        const permissoesAtuais = await knex('permissoes_usuarios')
            .where({ usuario_id: admin.id })
            .select('permissao_id');


        const permissoesAtuaisIds = permissoesAtuais.map(item => item.permissao_id);

        const novasPermissoes = permissoes
            .filter(p => !permissoesAtuaisIds.includes(p.id))
            .map(p => ({
                usuario_id: admin.id,
                permissao_id: p.id
            }));

        vinculosParaInserir.push(...novasPermissoes);
    }

    if (vinculosParaInserir.length > 0) {
        await knex('permissoes_usuarios').insert(vinculosParaInserir);
        console.log(`\n${logSymbols.success} ${chalk.green('VÍNCULO DE ADMIN CONCLUÍDO')}`);
        console.log(`${logSymbols.success} ${chalk.green(`Foram adicionados ${vinculosParaInserir.length} novos vínculos de permissão.`)}\n`);
    } else {
        console.log(`\n${logSymbols.info} ${chalk.cyan('Todos os admins já possuem as permissões de concessão automática.')}\n`);
    }

};
