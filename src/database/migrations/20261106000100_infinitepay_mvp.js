export async function up(knex) {
    if (!await knex.schema.hasTable('config_infinitepay')) {
        await knex.schema.createTable('config_infinitepay', t => {
            t.integer('id').primary();
            t.boolean('ativo').notNullable().defaultTo(false);
            t.string('handle', 150).nullable();
            t.smallint('assured_installments').notNullable().defaultTo(1);
            t.bigInteger('credencial_atual_id').nullable();
            t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('atualizado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        });
        await knex.raw(`ALTER TABLE config_infinitepay
            ADD CONSTRAINT ip_config_singleton CHECK (id=1),
            ADD CONSTRAINT ip_config_installments CHECK (assured_installments BETWEEN 0 AND 12),
            ADD CONSTRAINT ip_config_activation_ready CHECK (NOT ativo OR
                (credencial_atual_id IS NOT NULL AND handle IS NOT NULL AND btrim(handle) <> ''))`);
    }
    if (!await knex.schema.hasTable('infinitepay_credenciais')) {
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
        await knex.raw('ALTER TABLE infinitepay_credenciais ADD CONSTRAINT ip_credential_keyversion CHECK (key_version > 0)');
        await knex.schema.alterTable('config_infinitepay', t => {
            t.foreign('credencial_atual_id').references('id').inTable('infinitepay_credenciais').onDelete('RESTRICT');
        });
    }
    await knex('config_infinitepay').insert({ id: 1 }).onConflict('id').ignore();
    await knex.raw('ALTER TABLE config_infinitepay DROP CONSTRAINT IF EXISTS ip_config_phase1_disabled');

    const addColumn = async (table, name, definition) => {
        if (!await knex.schema.hasColumn(table, name)) await knex.schema.alterTable(table, definition);
    };
    await addColumn('metodos_pagamento', 'codigo', t => t.string('codigo', 80).nullable());
    await addColumn('metodos_pagamento', 'tipo_financeiro', t => t.string('tipo_financeiro', 20).notNullable().defaultTo('OUTRO'));
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ip_metodo_codigo_unique ON metodos_pagamento(codigo) WHERE codigo IS NOT NULL');
    const method = await knex('metodos_pagamento').where({ codigo: 'INFINITEPAY' }).first();
    if (!method) {
        const sameName = await knex('metodos_pagamento').where({ nome: 'InfinitePay (Pix ou cartão)' }).first();
        if (sameName && sameName.codigo !== null) throw new Error('Nome do método InfinitePay já associado a outro código.');
        if (sameName) await knex('metodos_pagamento').where({ id: sameName.id }).update({ codigo: 'INFINITEPAY' });
        else await knex('metodos_pagamento').insert({ nome: 'InfinitePay (Pix ou cartão)', codigo: 'INFINITEPAY', tipo_financeiro: 'OUTRO', ativo: true });
    }
    await addColumn('pedidos', 'fluxo_pagamento', t => t.string('fluxo_pagamento', 20).notNullable().defaultTo('POSTERIOR'));
    await addColumn('pedidos', 'liberado_cozinha_em', t => t.timestamp('liberado_cozinha_em', { useTz: true }).nullable());
    await addColumn('pedidos', 'client_request_id', t => t.uuid('client_request_id').nullable());
    await addColumn('pedidos', 'client_payload_hash', t => t.string('client_payload_hash', 64).nullable());
    await addColumn('pedidos', 'checkout_token_hash', t => t.string('checkout_token_hash', 64).nullable());
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ip_pedido_checkout_token_unique ON pedidos(checkout_token_hash) WHERE checkout_token_hash IS NOT NULL');

    if (!await knex.schema.hasTable('pagamentos')) {
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
            for (const name of ['provider_verified_at', 'pago_em', 'liquidado_em', 'estornado_em', 'last_checked_at']) {
                t.timestamp(name, { useTz: true }).nullable();
            }
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
            ADD CONSTRAINT ip_payment_credential_pair CHECK ((credencial_id IS NULL) = (handle_snapshot IS NULL))`);
        await knex.raw('CREATE UNIQUE INDEX ip_payment_chargeable ON pagamentos(pedido_id) WHERE bloqueia_nova_cobranca');
    }
    await addColumn('pagamentos', 'checkout_payload', t => t.jsonb('checkout_payload').nullable());
    const names = ['pagamentos.ativar', 'pagamentos.conciliar', 'pagamentos.configurar', 'pagamentos.visualizar'];
    await knex('permissoes').insert(names.map(nome => ({ nome, descricao: 'InfinitePay: ' + nome }))).onConflict('nome').ignore();
    const admins = await knex('usuarios as u').join('niveis_acesso as n', 'n.id', 'u.nivel_acesso_id')
        .where('n.nome', 'admin').where('u.ativo', true).whereNull('u.deletado_em').select('u.id');
    const permissions = await knex('permissoes').whereIn('nome', names).select('id');
    const grants = admins.flatMap(user => permissions.map(permission => ({ usuario_id: user.id, permissao_id: permission.id })));
    if (grants.length) await knex('permissoes_usuarios').insert(grants).onConflict(['usuario_id', 'permissao_id']).ignore();
    await knex('permissoes').where({ nome: 'pagamentos.ativar_producao' }).delete();
}

export async function down() {
    throw new Error('Migration preserva pagamentos existentes. Use uma nova migration incremental para correções.');
}
