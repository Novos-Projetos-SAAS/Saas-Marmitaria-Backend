export async function up(knex) {
    await knex.schema.createTable('infinitepay_controle_producao',t=>{
        t.uuid('implantacao_id').primary().references('identidade').inTable('infinitepay_identidade_ambiente').onDelete('RESTRICT');
        t.bigInteger('geracao').notNullable().defaultTo(0);
        t.boolean('auditoria_pendente').notNullable().defaultTo(false);
        t.timestamp('parada_em',{useTz:true}).nullable();
        t.integer('parado_por').nullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    });
    await knex.raw(`ALTER TABLE infinitepay_controle_producao ADD CONSTRAINT ip_control_generation CHECK(geracao>=0),
        ADD CONSTRAINT ip_control_stop_actor CHECK((parada_em IS NULL)=(parado_por IS NULL))`);
    await knex.schema.createTable('infinitepay_paradas_producao',t=>{
        t.uuid('implantacao_id').notNullable().references('identidade').inTable('infinitepay_identidade_ambiente').onDelete('RESTRICT');
        t.bigInteger('geracao').notNullable();t.primary(['implantacao_id','geracao']);
        t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.timestamp('criado_em',{useTz:true}).notNullable();t.boolean('auditoria_pendente').notNullable().defaultTo(false);
    });
    await knex.raw('ALTER TABLE infinitepay_paradas_producao ADD CONSTRAINT ip_stop_generation CHECK(geracao>0)');
    await knex.schema.createTable('infinitepay_sessoes_revogadas',t=>{
        t.uuid('implantacao_id').notNullable().references('identidade').inTable('infinitepay_identidade_ambiente').onDelete('RESTRICT');
        t.string('token_hash',64).notNullable();t.primary(['implantacao_id','token_hash']);
        t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.timestamp('revogado_em',{useTz:true}).notNullable();t.timestamp('expira_em',{useTz:true}).notNullable();
        t.boolean('auditoria_pendente').notNullable().defaultTo(false);
    });
    await knex.raw(`ALTER TABLE infinitepay_sessoes_revogadas ADD CONSTRAINT ip_revoked_session_hash CHECK(token_hash ~ '^[a-f0-9]{64}$'),
        ADD CONSTRAINT ip_revoked_session_time CHECK(expira_em>revogado_em)`);
    await knex.schema.alterTable('infinitepay_autorizacoes_producao',t=>{
        t.string('sessao_hash',64).nullable();t.bigInteger('controle_geracao').nullable();t.index('sessao_hash');
        t.integer('revogado_por').nullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.boolean('revogacao_auditoria_pendente').notNullable().defaultTo(false);
    });
    await knex.raw(`ALTER TABLE infinitepay_autorizacoes_producao ADD CONSTRAINT ip_grant_session_hash CHECK(sessao_hash IS NULL OR sessao_hash ~ '^[a-f0-9]{64}$'),
        ADD CONSTRAINT ip_grant_generation CHECK(controle_geracao IS NULL OR controle_geracao>=0)`);
    await knex.schema.createTable('infinitepay_controle_acoes',t=>{
        t.bigIncrements('id');t.uuid('implantacao_id').notNullable().references('identidade').inTable('infinitepay_identidade_ambiente').onDelete('RESTRICT');
        t.string('acao',20).notNullable();t.bigInteger('geracao').notNullable();
        t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.string('sessao_hash',64).nullable();t.timestamp('criado_em',{useTz:true}).notNullable();t.index(['implantacao_id','criado_em']);
    });
    await knex.raw(`ALTER TABLE infinitepay_controle_acoes ADD CONSTRAINT ip_control_action CHECK(acao IN ('STOP','RECOVER','SESSION_END')),
        ADD CONSTRAINT ip_control_action_generation CHECK(geracao>=0),
        ADD CONSTRAINT ip_control_action_session CHECK((acao='SESSION_END')=(sessao_hash IS NOT NULL)
            AND (sessao_hash IS NULL OR sessao_hash ~ '^[a-f0-9]{64}$'))`);
    // Empty by design: migrations neither approve operators nor declare a running installation.
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve dados e estrutura de controle e revogação.');
}
