// Additive only. Actual method IDs must be reviewed separately; no automatic backfill.
export async function up(knex) {
    await knex.schema.alterTable('metodos_pagamento', t => {
        t.string('codigo', 80).nullable();
        t.string('tipo_financeiro', 20).notNullable().defaultTo('OUTRO');
    });
    await knex.raw("ALTER TABLE metodos_pagamento ADD CONSTRAINT ip_metodo_tipo CHECK (tipo_financeiro IN ('PIX','CREDITO','DEBITO','DINHEIRO','OUTRO'))");
    await knex.raw("CREATE UNIQUE INDEX ip_metodo_codigo_unique ON metodos_pagamento(codigo) WHERE codigo IS NOT NULL");
    await knex.schema.alterTable('pedidos', t => {
        t.string('fluxo_pagamento', 20).notNullable().defaultTo('POSTERIOR');
        t.timestamp('liberado_cozinha_em', { useTz: true }).nullable();
        t.uuid('client_request_id').nullable();
        t.string('client_payload_hash', 64).nullable();
    });
    await knex.raw("ALTER TABLE pedidos ADD CONSTRAINT ip_pedido_fluxo CHECK (fluxo_pagamento IN ('POSTERIOR','INFINITEPAY'))");
    await knex.raw("ALTER TABLE pedidos ADD CONSTRAINT ip_pedido_request_hash CHECK ((client_request_id IS NULL AND client_payload_hash IS NULL) OR (client_request_id IS NOT NULL AND client_payload_hash IS NOT NULL AND client_payload_hash ~ '^[a-f0-9]{64}$'))");
    await knex.raw("CREATE UNIQUE INDEX ip_pedido_request_unique ON pedidos(client_request_id) WHERE client_request_id IS NOT NULL");
}
export async function down(knex) {
    const used = await knex('pedidos').where('fluxo_pagamento', 'INFINITEPAY').orWhereNotNull('client_request_id').first('id');
    const classified = await knex('metodos_pagamento').whereNotNull('codigo').first('id');
    if (used || classified) throw new Error('Rollback bloqueado: dados financeiros ou classificação devem ser preservados.');
    await knex.raw('DROP INDEX ip_pedido_request_unique');
    await knex.raw('ALTER TABLE pedidos DROP CONSTRAINT ip_pedido_fluxo');
    await knex.raw('ALTER TABLE pedidos DROP CONSTRAINT ip_pedido_request_hash');
    await knex.schema.alterTable('pedidos', t => t.dropColumns('fluxo_pagamento', 'liberado_cozinha_em', 'client_request_id', 'client_payload_hash'));
    await knex.raw('DROP INDEX ip_metodo_codigo_unique');
    await knex.raw('ALTER TABLE metodos_pagamento DROP CONSTRAINT ip_metodo_tipo');
    await knex.schema.alterTable('metodos_pagamento', t => t.dropColumns('codigo', 'tipo_financeiro'));
}
