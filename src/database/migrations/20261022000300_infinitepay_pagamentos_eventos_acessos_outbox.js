export async function up(knex) {
    await knex.schema.createTable('pagamentos', t => {
        t.bigIncrements('id');
        t.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.integer('tentativa_numero').notNullable();
        t.string('order_nsu', 120).notNullable().unique();
        t.string('provedor', 20).notNullable().defaultTo('INFINITEPAY');
        t.string('status', 30).notNullable();
        t.boolean('bloqueia_nova_cobranca').notNullable().defaultTo(true);
        t.bigInteger('credencial_id').nullable();
        t.string('handle_snapshot', 150).nullable();
        t.bigInteger('valor_centavos').notNullable();
        t.bigInteger('valor_base_provider_centavos').nullable();
        t.bigInteger('valor_pago_provider_centavos').nullable();
        t.text('checkout_url').nullable();
        t.timestamp('valid_until', { useTz: true }).notNullable();
        t.string('return_nonce_hash', 64).nullable().unique();
        t.string('transaction_nsu', 255).nullable();
        t.string('invoice_slug', 255).nullable();
        t.string('capture_method', 32).nullable();
        t.smallint('installments').nullable();
        t.text('receipt_url').nullable();
        for (const name of ['provider_verified_at','pago_em','liquidado_em','estornado_em','last_checked_at']) t.timestamp(name, { useTz: true }).nullable();
        t.string('error_code', 100).nullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('atualizado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.unique(['pedido_id', 'tentativa_numero']);
        t.index(['invoice_slug']);
        t.index(['transaction_nsu']);
        t.foreign(['credencial_id', 'handle_snapshot']).references(['id', 'handle']).inTable('infinitepay_credenciais').onDelete('RESTRICT');
    });
    await knex.raw(`ALTER TABLE pagamentos
        ADD CONSTRAINT ip_payment_status CHECK (status IN ('CRIANDO','AGUARDANDO','INCERTA','FALHOU','EXPIRADA','CANCELADA','PAGA','LIQUIDADA','ESTORNADA','DIVERGENTE')),
        ADD CONSTRAINT ip_payment_value CHECK (valor_centavos > 0),
        ADD CONSTRAINT ip_payment_attempt CHECK (tentativa_numero > 0),
        ADD CONSTRAINT ip_payment_provider CHECK (provedor='INFINITEPAY'),
        ADD CONSTRAINT ip_payment_credential_pair CHECK ((credencial_id IS NULL) = (handle_snapshot IS NULL)),
        ADD CONSTRAINT ip_payment_nonce_hash CHECK (return_nonce_hash IS NULL OR return_nonce_hash ~ '^[a-f0-9]{64}$')
    `);
    await knex.raw('CREATE UNIQUE INDEX ip_payment_chargeable ON pagamentos(pedido_id) WHERE bloqueia_nova_cobranca');
    await knex.schema.createTable('pagamentos_eventos', t => {
        t.bigIncrements('id');
        t.bigInteger('pagamento_id').nullable().references('id').inTable('pagamentos').onDelete('RESTRICT');
        t.text('event_key').notNullable().unique();
        t.string('tipo_evento', 100).notNullable();
        t.jsonb('payload_filtrado').notNullable().defaultTo('{}');
        t.string('status_processamento', 30).notNullable().defaultTo('PENDENTE');
        t.integer('tentativas').notNullable().defaultTo(0);
        t.timestamp('recebido_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('processado_em', { useTz: true }).nullable();
        t.timestamp('proxima_tentativa_em', { useTz: true }).nullable();
        t.timestamp('locked_until', { useTz: true }).nullable();
        t.uuid('locked_by').nullable();
        t.string('ultimo_erro', 100).nullable();
        t.index(['status_processamento', 'proxima_tentativa_em']);
    });
    await knex.raw("ALTER TABLE pagamentos_eventos ADD CONSTRAINT ip_event_state CHECK (status_processamento IN ('PENDENTE','PROCESSANDO','CONCLUIDO','ERRO','PENDENTE_IDENTIFICACAO')), ADD CONSTRAINT ip_event_attempts CHECK (tentativas>=0)");
    await knex.schema.createTable('pedido_acessos', t => {
        t.bigIncrements('id');
        t.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.string('token_hash', 64).notNullable().unique();
        t.string('escopo', 16).notNullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('expira_em', { useTz: true }).notNullable();
        t.timestamp('revogado_em', { useTz: true }).nullable();
        t.timestamp('ultimo_acesso_em', { useTz: true }).nullable();
        t.index(['pedido_id']);
    });
    await knex.raw("ALTER TABLE pedido_acessos ADD CONSTRAINT ip_access_scope CHECK (escopo IN ('STATUS','TITULAR')), ADD CONSTRAINT ip_access_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'), ADD CONSTRAINT ip_access_expiry CHECK (expira_em > criado_em)");
    await knex.schema.createTable('outbox_eventos', t => {
        t.bigIncrements('id');
        t.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.string('tipo', 40).notNullable();
        t.text('chave_unica').notNullable().unique();
        t.jsonb('payload_reduzido').notNullable().defaultTo('{}');
        t.string('status', 20).notNullable().defaultTo('PENDENTE');
        t.integer('tentativas').notNullable().defaultTo(0);
        t.timestamp('proxima_tentativa_em', { useTz: true }).nullable();
        t.timestamp('locked_until', { useTz: true }).nullable();
        t.uuid('locked_by').nullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('processado_em', { useTz: true }).nullable();
        t.index(['status', 'proxima_tentativa_em']);
    });
    await knex.raw("ALTER TABLE outbox_eventos ADD CONSTRAINT ip_outbox_status CHECK (status IN ('PENDENTE','PROCESSANDO','CONCLUIDO','ERRO')), ADD CONSTRAINT ip_outbox_attempts CHECK (tentativas>=0), ADD CONSTRAINT ip_outbox_type CHECK (tipo IN ('PEDIDO_LIBERADO','PAGAMENTO_ATUALIZADO'))");
    await knex.raw("CREATE UNIQUE INDEX ip_outbox_release_once ON outbox_eventos(pedido_id) WHERE tipo='PEDIDO_LIBERADO'");
}
export async function down(knex) {
    for (const name of ['pagamentos','pagamentos_eventos','pedido_acessos','outbox_eventos']) {
        if (await knex(name).first('id')) throw new Error('Rollback bloqueado: registros financeiros existentes devem ser preservados.');
    }
    for (const name of ['outbox_eventos','pedido_acessos','pagamentos_eventos','pagamentos']) await knex.schema.dropTable(name);
}
