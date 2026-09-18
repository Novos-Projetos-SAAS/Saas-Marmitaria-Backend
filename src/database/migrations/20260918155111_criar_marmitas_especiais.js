/**
 * Cria o módulo de marmitas especiais e permite que
 * itens_pedido represente três tipos de item:
 *
 * 1. MARMITA PERSONALIZADA
 *    tamanho_marmita_id preenchido
 *
 * 2. PRODUTO
 *    produto_id preenchido
 *
 * 3. MARMITA ESPECIAL
 *    marmita_especial_id preenchido
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.createTable('marmitas_especiais', (table) => {
        table.increments('id').primary();

        table.string('nome', 150)
            .notNullable();

        table.text('descricao')
            .nullable();

        table.decimal('preco', 10, 2)
            .notNullable();

        table.boolean('ativo')
            .notNullable()
            .defaultTo(true);

        table.timestamp('criado_em')
            .notNullable()
            .defaultTo(knex.fn.now());

        table.timestamp('atualizado_em')
            .notNullable()
            .defaultTo(knex.fn.now());

        table.timestamp('deletado_em')
            .nullable();

        table.index(
            ['ativo', 'deletado_em'],
            'idx_marmitas_especiais_status'
        );
    });

    await knex.raw(`
        ALTER TABLE marmitas_especiais
        ADD CONSTRAINT chk_marmitas_especiais_preco
        CHECK (preco > 0);
    `);

    /**
     * A constraint atual permite somente:
     *
     * tamanho_marmita_id
     * OU
     * produto_id
     *
     * Precisamos removê-la antes de adicionar a terceira origem.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        DROP CONSTRAINT IF EXISTS chk_itens_pedido_origem;
    `);

    await knex.schema.alterTable('itens_pedido', (table) => {
        table.integer('marmita_especial_id')
            .unsigned()
            .nullable();

        table.foreign('marmita_especial_id')
            .references('id')
            .inTable('marmitas_especiais')
            .onDelete('RESTRICT')
            .onUpdate('CASCADE');

        /**
         * Snapshot do nome e descrição no momento da venda.
         *
         * Assim um pedido antigo não muda caso o cadastro
         * da marmita especial seja editado futuramente.
         */
        table.string('nome_item_snapshot', 150)
            .nullable();

        table.text('descricao_item_snapshot')
            .nullable();

        table.index(
            ['marmita_especial_id'],
            'idx_itens_pedido_marmita_especial_id'
        );
    });

    /**
     * Exatamente UMA origem deve estar preenchida.
     *
     * Marmita normal:
     * tamanho preenchido, produto e especial NULL.
     *
     * Produto:
     * produto preenchido, tamanho e especial NULL.
     *
     * Marmita especial:
     * especial preenchida, tamanho e produto NULL.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        ADD CONSTRAINT chk_itens_pedido_origem
        CHECK (
            (
                tamanho_marmita_id IS NOT NULL
                AND produto_id IS NULL
                AND marmita_especial_id IS NULL
            )
            OR
            (
                tamanho_marmita_id IS NULL
                AND produto_id IS NOT NULL
                AND marmita_especial_id IS NULL
            )
            OR
            (
                tamanho_marmita_id IS NULL
                AND produto_id IS NULL
                AND marmita_especial_id IS NOT NULL
            )
        );
    `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    /**
     * Não permite rollback caso já existam pedidos
     * utilizando marmitas especiais.
     */
    const registroEspecial = await knex('itens_pedido')
        .whereNotNull('marmita_especial_id')
        .first('id');

    if (registroEspecial) {
        throw new Error(
            'Rollback cancelado: existem marmitas especiais vinculadas a pedidos.'
        );
    }

    await knex.raw(`
        ALTER TABLE itens_pedido
        DROP CONSTRAINT IF EXISTS chk_itens_pedido_origem;
    `);

    await knex.schema.alterTable('itens_pedido', (table) => {
        table.dropIndex(
            ['marmita_especial_id'],
            'idx_itens_pedido_marmita_especial_id'
        );

        table.dropForeign(
            ['marmita_especial_id']
        );

        table.dropColumn('marmita_especial_id');
        table.dropColumn('nome_item_snapshot');
        table.dropColumn('descricao_item_snapshot');
    });

    /**
     * Restaura a regra anterior:
     * marmita normal OU produto.
     */
    await knex.raw(`
        ALTER TABLE itens_pedido
        ADD CONSTRAINT chk_itens_pedido_origem
        CHECK (
            (
                tamanho_marmita_id IS NOT NULL
                AND produto_id IS NULL
            )
            OR
            (
                tamanho_marmita_id IS NULL
                AND produto_id IS NOT NULL
            )
        );
    `);

    await knex.schema.dropTableIfExists('marmitas_especiais');
}