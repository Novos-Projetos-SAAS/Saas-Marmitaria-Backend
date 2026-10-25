export async function up(knex) {
    await knex.schema.createTable('checkout_sessoes', t => {
        t.string('token_hash', 64).primary();
        t.uuid('requisicao_atual').notNullable().unique();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('expira_em', { useTz: true }).notNullable();
        t.timestamp('revogado_em', { useTz: true }).nullable();
    });
    await knex.schema.createTable('checkout_requisicoes', t => {
        t.uuid('id').primary();
        t.string('sessao_hash', 64).notNullable().references('token_hash').inTable('checkout_sessoes').onDelete('RESTRICT');
        t.string('payload_hash', 64).nullable();
        t.integer('pedido_id').nullable().unique().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index(['sessao_hash']);
        t.unique(['id', 'sessao_hash']);
    });
    await knex.raw(`ALTER TABLE checkout_sessoes ADD CONSTRAINT checkout_session_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        ADD CONSTRAINT checkout_session_expiry CHECK (expira_em > criado_em)`);
    await knex.raw(`ALTER TABLE checkout_requisicoes ADD CONSTRAINT checkout_request_binding CHECK ((pedido_id IS NULL) = (payload_hash IS NULL)),
        ADD CONSTRAINT checkout_request_hash CHECK (payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$')`);
    await knex.raw(`ALTER TABLE checkout_sessoes ADD CONSTRAINT checkout_current_owner
        FOREIGN KEY (requisicao_atual, token_hash) REFERENCES checkout_requisicoes(id, sessao_hash)
        DEFERRABLE INITIALLY DEFERRED`);
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): os dados e a estrutura existentes devem ser preservados. Use uma migration aditiva de correção.');
}
