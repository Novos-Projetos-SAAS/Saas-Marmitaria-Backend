/**
 * Seed responsável por garantir a existência do usuário administrador principal.
 *
 * Comportamento:
 * - cria o usuário caso ainda não exista;
 * - atualiza/promove o usuário caso o e-mail já esteja cadastrado;
 * - reativa o usuário caso esteja inativo ou excluído logicamente;
 * - vincula as permissões automáticas existentes ao administrador;
 * - mantém impressao.assinar dependente de concessão explícita;
 * - pode ser executada várias vezes sem duplicar usuário ou permissões.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

import chalk from 'chalk';
import logSymbols from 'log-symbols';
import { hashPassword } from '../../utils/passwordUtils.js';

export async function seed(knex) {

    // Seed legado de desenvolvimento redefine senha e reativa contas.
    // Nunca permitir execução acidental em banco destinado a produção.
    if(process.env.NODE_ENV==='production' || process.env.INFINITEPAY_MODE==='production') {
        throw new Error('Bootstrap legado de senha administrativa bloqueado em produção. Use a seed 14 específica.');
    }
    // Dados do administrador inicial do ambiente de desenvolvimento.
    const ADMIN = {
        nome: 'Nei',
        email: 'nei@teste.com',
        senha: process.env.SEED_ADMIN_PASSWORD || 'Senhaforte123@',
        nivel_acesso_id: 1
    };

    // Toda a operação é atômica: se alguma etapa falhar,
    // nenhuma alteração parcial será mantida no banco.
    await knex.transaction(async (trx) => {
        // Gera o hash usando o mesmo utilitário utilizado pelo restante do projeto.
        // A senha nunca é persistida em texto puro na tabela de usuários.
        const senhaHash = await hashPassword(ADMIN.senha);

        // Procura pelo e-mail sem diferenciar maiúsculas e minúsculas.
        const usuarioExistente = await trx('usuarios')
            .whereRaw('LOWER(email) = ?', [ADMIN.email.toLowerCase()])
            .first();

        let adminId;

        if (usuarioExistente) {
            // Se o usuário já existir, ele é promovido/normalizado como administrador.
            // Também restaura um eventual soft delete e redefine a senha solicitada.
            const [adminAtualizado] = await trx('usuarios')
                .where({ id: usuarioExistente.id })
                .update({
                    nome: ADMIN.nome,
                    email: ADMIN.email.toLowerCase(),
                    senha_hash: senhaHash,
                    nivel_acesso_id: ADMIN.nivel_acesso_id,
                    ativo: true,
                    deletado_em: null,
                    atualizado_em: trx.fn.now()
                })
                .returning(['id']);

            adminId = adminAtualizado.id;

            console.log(
                logSymbols.info,
                chalk.cyan(`Administrador atualizado: ${ADMIN.email}`)
            );
        } else {
            // Se ainda não existir, cria o administrador já ativo e com nível de acesso 1.
            const [novoAdmin] = await trx('usuarios')
                .insert({
                    nome: ADMIN.nome,
                    email: ADMIN.email.toLowerCase(),
                    senha_hash: senhaHash,
                    nivel_acesso_id: ADMIN.nivel_acesso_id,
                    ativo: true
                })
                .returning(['id']);

            adminId = novoAdmin.id;

            console.log(
                logSymbols.success,
                chalk.green(`Administrador criado: ${ADMIN.email}`)
            );
        }

        // Busca o catálogo automático somente depois de todas as outras seeds terem rodado.
        // Como esta é a seed 09, ela também inclui as permissões de relatórios da seed 07.
        // Produção InfinitePay e QZ exigem autorização explícita e individual.
        const permissoes = await trx('permissoes')
            .whereNotIn('nome', ['impressao.assinar', 'pagamentos.ativar_producao']).select('id');

        if (permissoes.length === 0) {
            console.log(
                logSymbols.warning,
                chalk.yellow(
                    'Nenhuma permissão encontrada para vincular ao administrador.'
                )
            );

            return;
        }

        // Monta um vínculo para cada permissão de concessão automática.
        const vinculos = permissoes.map((permissao) => ({
            usuario_id: adminId,
            permissao_id: permissao.id
        }));

        // A constraint UNIQUE(usuario_id, permissao_id) impede duplicações.
        // O ignore torna a seed segura para ser executada novamente.
        await trx('permissoes_usuarios')
            .insert(vinculos)
            .onConflict(['usuario_id', 'permissao_id'])
            .ignore();

        console.log(
            logSymbols.success,
            chalk.green(
                `Permissões automáticas vinculadas para ${ADMIN.email}: ${permissoes.length} permissões verificadas.`
            )
        );
    });
}
