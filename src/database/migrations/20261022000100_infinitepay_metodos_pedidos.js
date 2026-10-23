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
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): os dados e a estrutura existentes devem ser preservados. Use uma migration aditiva de correção.');
}
