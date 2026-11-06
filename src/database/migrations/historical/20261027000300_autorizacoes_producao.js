export async function up(knex) {
    // Permission exists without assigning production activation to any operator.
    await knex('permissoes').insert({nome:'pagamentos.ativar_producao',descricao:'Aprovar e revogar capacidades InfinitePay de produção'})
        .onConflict('nome').ignore();
    await knex.schema.createTable('infinitepay_autorizacoes_producao',t=>{
        t.uuid('id').primary();t.uuid('boot_id').notNullable();
        t.uuid('implantacao_id').notNullable().references('identidade').inTable('infinitepay_identidade_ambiente').onDelete('RESTRICT');
        t.string('banco',63).notNullable();t.string('ambiente',20).notNullable();t.text('origem_https').notNullable();
        t.bigInteger('credencial_id').notNullable().references('id').inTable('infinitepay_credenciais').onDelete('RESTRICT');
        t.string('credencial_hash',64).notNullable();t.string('chave_sessao_hash',64).notNullable();t.string('assinatura',64).notNullable();
        t.specificType('capacidades','text[]').notNullable();t.string('destino',80).nullable();
        t.integer('aprovado_por').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.timestamp('criado_em',{useTz:true}).notNullable();t.timestamp('expira_em',{useTz:true}).notNullable();
        t.timestamp('revogado_em',{useTz:true}).nullable();
        t.index(['boot_id','expira_em']);
    });
    await knex.raw(`ALTER TABLE infinitepay_autorizacoes_producao
        ADD CONSTRAINT ip_authorization_environment CHECK(ambiente='production'),
        ADD CONSTRAINT ip_authorization_origin CHECK(origem_https ~ '^https://'),
        ADD CONSTRAINT ip_authorization_lifetime CHECK(expira_em>criado_em AND expira_em<=criado_em+interval '15 minutes'),
        ADD CONSTRAINT ip_authorization_recipient CHECK(('DELIVER_ORDER'=ANY(capacidades))=(destino IS NOT NULL) AND
            (destino IS NULL OR destino ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$')),
        ADD CONSTRAINT ip_authorization_hashes CHECK(credencial_hash ~ '^[a-f0-9]{64}$' AND chave_sessao_hash ~ '^[a-f0-9]{64}$' AND assinatura ~ '^[a-f0-9]{64}$'),
        ADD CONSTRAINT ip_authorization_capabilities CHECK(cardinality(capacidades)>0 AND array_position(capacidades,NULL) IS NULL
            AND capacidades <@ ARRAY['WORKER','CREATE_LINK','VERIFY_PAYMENT','DELIVER_ORDER']::text[])`);
    await knex.raw('CREATE UNIQUE INDEX ip_authorization_active_credential ON infinitepay_autorizacoes_producao(boot_id,credencial_id) WHERE revogado_em IS NULL');
    await knex.schema.createTable('infinitepay_autorizacao_decisoes',t=>{
        t.bigIncrements('id');t.uuid('boot_id').notNullable();
        t.uuid('autorizacao_id').nullable().references('id').inTable('infinitepay_autorizacoes_producao').onDelete('RESTRICT');
        t.integer('usuario_id').nullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.string('operacao',30).notNullable();t.string('decisao',5).notNullable();t.string('codigo',60).notNullable();
        t.timestamp('criado_em',{useTz:true}).notNullable();t.index(['boot_id','criado_em']);
    });
    await knex.raw(`ALTER TABLE infinitepay_autorizacao_decisoes
        ADD CONSTRAINT ip_authorization_audit_operation CHECK(operacao IN ('WORKER','CREATE_LINK','VERIFY_PAYMENT','DELIVER_ORDER','APPROVE','REVOKE','EMERGENCY_STOP','INVALID')),
        ADD CONSTRAINT ip_authorization_audit_decision CHECK(decisao IN ('ALLOW','DENY')),
        ADD CONSTRAINT ip_authorization_audit_code CHECK(codigo ~ '^[A-Z][A-Z0-9_]{1,59}$')`);
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve dados e estrutura de autorizações e auditoria.');
}
