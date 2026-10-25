export async function up(knex) {
    // Replace only the deliberate activation lock; preserve data and financial structures.
    await knex.raw(`ALTER TABLE config_infinitepay DROP CONSTRAINT ip_config_phase1_disabled,
        ADD CONSTRAINT ip_config_activation_ready CHECK (NOT ativo OR
            (credencial_atual_id IS NOT NULL AND handle IS NOT NULL AND btrim(handle) <> ''))`);
    await knex.schema.createTable('infinitepay_entregas_homologacao', table => {
        table.text('chave_unica').primary();
        table.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');
        table.timestamp('recebido_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve dados, estruturas, credenciais e evidências financeiras.');
}
