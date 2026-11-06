export async function up(knex) {
    await knex.schema.createTable('qz_proto_estacoes', t => {
        t.uuid('id').primary();
        t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.text('impressora').notNullable();
        t.boolean('ativo').notNullable().defaultTo(true);
    });
    await knex.schema.createTable('qz_proto_documentos', t => {
        t.uuid('id').primary();
        t.uuid('estacao_id').notNullable().references('id').inTable('qz_proto_estacoes').onDelete('RESTRICT');
        // One original print job per order, including attempts from different stations.
        t.integer('pedido_id').notNullable().unique().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.jsonb('params').notNullable();
        t.string('source_hash', 64).notNullable();
        t.check("source_hash ~ '^[a-f0-9]{64}$'");
        t.timestamp('expira_em', {useTz: true}).notNullable();
    });
    await knex.schema.createTable('qz_proto_intencoes', t => {
        t.uuid('id').primary();
        t.integer('usuario_id').notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
        t.string('sessao_hash', 64).notNullable();
        t.uuid('estacao_id').notNullable().references('id').inTable('qz_proto_estacoes').onDelete('RESTRICT');
        t.uuid('documento_id').unique().references('id').inTable('qz_proto_documentos').onDelete('RESTRICT');
        t.text('chamada').notNullable();
        t.check("chamada IN ('printers.find','print')");
        t.string('request_digest', 64).notNullable().unique();
        t.string('params_hash', 64).notNullable();
        t.string('operacao_hash', 64).notNullable();
        for (const column of ['sessao_hash', 'request_digest', 'params_hash', 'operacao_hash']) {
            t.check("?? ~ '^[a-f0-9]{64}$'", [column]);
        }
        t.bigInteger('request_timestamp').notNullable();
        t.text('estado').notNullable();
        t.check("estado IN ('RESERVADA','CONSUMIDA','ASSINADA')");
        t.timestamp('criado_em', {useTz: true}).notNullable();
        t.timestamp('expira_em', {useTz: true}).notNullable();
        t.index(['usuario_id', 'criado_em']);
        t.index(['estacao_id', 'criado_em']);
        t.index('expira_em');
    });
    await knex.schema.createTable('qz_proto_auditoria', t => {
        t.bigIncrements('id');
        t.integer('usuario_id').references('id').inTable('usuarios').onDelete('RESTRICT');
        t.uuid('intencao_id').references('id').inTable('qz_proto_intencoes').onDelete('RESTRICT');
        t.string('operacao', 20).notNullable();
        t.string('decisao', 5).notNullable();
        t.string('codigo', 40).notNullable();
        t.timestamp('criado_em', {useTz: true}).notNullable();
        t.index(['usuario_id', 'criado_em']);
        t.index('intencao_id');
    });
    // Catalog only: every operator, including administrators, requires an explicit grant.
    await knex('permissoes').insert({nome: 'impressao.assinar',
        descricao: 'Assinar impressão QZ vinculada a uma intenção autorizada.'}).onConflict('nome').ignore();
}

export async function down() {
    throw new Error('Rollback bloqueado (forward-only): os dados e a estrutura existentes devem ser preservados. Use uma migration aditiva de correção.');
}
