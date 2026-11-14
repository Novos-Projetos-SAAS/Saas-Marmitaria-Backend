export async function up(knex) {
    for (const name of ['pix_habilitado', 'credito_habilitado']) {
        if (!await knex.schema.hasColumn('config_infinitepay', name)) {
            await knex.schema.alterTable('config_infinitepay', table => {
                table.boolean(name).notNullable().defaultTo(true);
            });
        }
    }
}

export async function down() {
    throw new Error('Migration preserva preferências financeiras. Use uma nova migration incremental para correções.');
}
