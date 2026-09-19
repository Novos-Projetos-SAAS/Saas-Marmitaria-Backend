/**
 * Adiciona suporte a produtos que funcionam como adicionais
 * vinculados a uma marmita específica.
 *
 * produtos.tipo_aplicacao:
 *
 * PEDIDO
 * - produto independente do pedido
 * - exemplo: Coca-Cola, água, sobremesa
 *
 * MARMITA
 * - adicional que precisa pertencer a uma marmita
 * - exemplo: ovo, bacon, molho, carne extra
 *
 *
 * itens_pedido.item_marmita_id:
 *
 * Quando preenchido em um item do tipo PRODUTO,
 * identifica a qual marmita aquele produto pertence.
 *
 * Exemplo:
 *
 * id 10 = Marmita M
 * id 11 = Ovo -> item_marmita_id = 10
 * id 12 = Coca-Cola -> item_marmita_id = NULL
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {

    /**
     * ---------------------------------------------------------
     * PRODUTOS
     * ---------------------------------------------------------
     */

    await knex.schema.alterTable('produtos', (table) => {

        /**
         * Define onde o produto pode ser utilizado.
         *
         * PEDIDO:
         * produto independente.
         *
         * MARMITA:
         * adicional vinculado a uma marmita.
         *
         * Usamos PEDIDO como padrão para manter
         * compatibilidade com todos os produtos atuais.
         */
        table.string('tipo_aplicacao', 20)
            .notNullable()
            .defaultTo('PEDIDO');


        /**
         * Ajuda nas consultas do cardápio:
         *
         * GET produtos tipo MARMITA
         * GET produtos tipo PEDIDO
         */
        table.index(
            [
                'tipo_aplicacao',
                'ativo',
                'disponivel_hoje'
            ],
            'idx_produtos_tipo_aplicacao_cardapio'
        );
    });


    /**
     * Garante que somente valores conhecidos
     * possam ser gravados.
     */
    await knex.raw(`
        ALTER TABLE produtos
        ADD CONSTRAINT chk_produtos_tipo_aplicacao
        CHECK (
            tipo_aplicacao IN (
                'PEDIDO',
                'MARMITA'
            )
        );
    `);


    /**
     * ---------------------------------------------------------
     * ITENS DO PEDIDO
     * ---------------------------------------------------------
     */

    await knex.schema.alterTable('itens_pedido', (table) => {

        /**
         * Quando um produto for adicional de uma marmita,
         * este campo aponta para o item da marmita.
         *
         * NULL:
         * produto geral do pedido.
         *
         * preenchido:
         * produto vinculado a uma marmita.
         */
        table.integer('item_marmita_id')
            .unsigned()
            .nullable();


        /**
         * Relacionamento da própria tabela itens_pedido
         * com ela mesma.
         */
        table.foreign(
            'item_marmita_id',
            'fk_itens_pedido_item_marmita'
        )
            .references('id')
            .inTable('itens_pedido')
            .onDelete('CASCADE')
            .onUpdate('CASCADE');


        table.index(
            ['item_marmita_id'],
            'idx_itens_pedido_item_marmita_id'
        );
    });


    /**
     * Somente itens do tipo PRODUTO podem apontar
     * para uma marmita.
     *
     * Assim uma marmita não pode acidentalmente
     * ser cadastrada como "adicional" de outra.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        ADD CONSTRAINT chk_itens_pedido_item_marmita_produto
        CHECK (
            item_marmita_id IS NULL
            OR produto_id IS NOT NULL
        );
    `);


    /**
     * Evita que um item aponte para ele próprio.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        ADD CONSTRAINT chk_itens_pedido_item_marmita_auto_referencia
        CHECK (
            item_marmita_id IS NULL
            OR item_marmita_id <> id
        );
    `);
}


/**
 * Reverte a implementação.
 *
 * Protegemos o rollback caso já existam adicionais
 * vinculados às marmitas.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {

    const adicionalVinculado = await knex('itens_pedido')
        .whereNotNull('item_marmita_id')
        .first('id');


    if (adicionalVinculado) {
        throw new Error(
            'Rollback cancelado: existem adicionais vinculados a marmitas.'
        );
    }


    const produtoMarmita = await knex('produtos')
        .where('tipo_aplicacao', 'MARMITA')
        .first('id');


    if (produtoMarmita) {
        throw new Error(
            'Rollback cancelado: existem produtos classificados como adicionais de marmita.'
        );
    }


    /**
     * Remove constraints relacionadas ao vínculo.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        DROP CONSTRAINT IF EXISTS
        chk_itens_pedido_item_marmita_auto_referencia;
    `);


    await knex.raw(`
        ALTER TABLE itens_pedido
        DROP CONSTRAINT IF EXISTS
        chk_itens_pedido_item_marmita_produto;
    `);


    /**
     * Remove FK, índice e coluna.
     */
    await knex.schema.alterTable('itens_pedido', (table) => {

        table.dropIndex(
            ['item_marmita_id'],
            'idx_itens_pedido_item_marmita_id'
        );

        table.dropForeign(
            ['item_marmita_id'],
            'fk_itens_pedido_item_marmita'
        );

        table.dropColumn('item_marmita_id');
    });


    /**
     * Remove estrutura de tipo de produto.
     */
    await knex.raw(`
        ALTER TABLE produtos
        DROP CONSTRAINT IF EXISTS
        chk_produtos_tipo_aplicacao;
    `);


    await knex.schema.alterTable('produtos', (table) => {

        table.dropIndex(
            [
                'tipo_aplicacao',
                'ativo',
                'disponivel_hoje'
            ],
            'idx_produtos_tipo_aplicacao_cardapio'
        );

        table.dropColumn('tipo_aplicacao');
    });
}