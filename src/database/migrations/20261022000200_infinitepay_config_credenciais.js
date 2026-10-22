export async function up(knex) {
    await knex.schema.createTable('config_infinitepay', t => {
        t.integer('id').primary();
        t.boolean('ativo').notNullable().defaultTo(false);
        t.string('handle', 150).nullable();
        t.smallint('assured_installments').notNullable().defaultTo(1);
        t.bigInteger('credencial_atual_id').nullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('atualizado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw("ALTER TABLE config_infinitepay ADD CONSTRAINT ip_config_singleton CHECK (id=1), ADD CONSTRAINT ip_config_installments CHECK (assured_installments BETWEEN 0 AND 12), ADD CONSTRAINT ip_config_phase1_disabled CHECK (ativo=false)");
    await knex('config_infinitepay').insert({ id: 1 });
    await knex.schema.createTable('infinitepay_credenciais', t => {
        t.bigIncrements('id');
        t.integer('config_id').notNullable().defaultTo(1).references('id').inTable('config_infinitepay').onDelete('RESTRICT');
        t.string('handle', 150).notNullable();
        t.text('api_key_ciphertext').notNullable();
        t.string('api_key_iv', 24).notNullable();
        t.string('api_key_tag', 24).notNullable();
        t.smallint('key_version').notNullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.unique(['id', 'handle']);
    });
    await knex.raw("ALTER TABLE infinitepay_credenciais ADD CONSTRAINT ip_credential_keyversion CHECK (key_version > 0)");
    await knex.schema.alterTable('config_infinitepay', t => {
        t.foreign('credencial_atual_id').references('id').inTable('infinitepay_credenciais').onDelete('RESTRICT');
    });
    await knex.raw(`
        CREATE FUNCTION ip_credencial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Credencial financeira imutável; crie uma nova versão'; END;
        $$;
        CREATE TRIGGER ip_credencial_no_update BEFORE UPDATE ON infinitepay_credenciais
        FOR EACH ROW EXECUTE FUNCTION ip_credencial_immutable();
    `);
}
export async function down(knex) {
    if (await knex('infinitepay_credenciais').first('id')) throw new Error('Rollback bloqueado: credenciais financeiras existentes.');
    await knex.schema.alterTable('config_infinitepay', t => t.dropForeign('credencial_atual_id'));
    await knex.schema.dropTable('infinitepay_credenciais');
    await knex.raw('DROP FUNCTION ip_credencial_immutable()');
    await knex.schema.dropTable('config_infinitepay');
}
