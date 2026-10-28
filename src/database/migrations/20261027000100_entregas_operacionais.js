export async function up(knex) {
    await knex.schema.createTable('infinitepay_entregas_operacionais', t => {
        t.text('chave_unica').primary().references('chave_unica').inTable('outbox_eventos').onDelete('RESTRICT');
        t.bigInteger('outbox_id').notNullable().unique().references('id').inTable('outbox_eventos').onDelete('RESTRICT');
        t.integer('pedido_id').notNullable().references('id').inTable('pedidos').onDelete('RESTRICT');
        t.string('destino', 80).notNullable();
        t.string('status', 20).notNullable().defaultTo('PENDENTE');
        t.integer('tentativas').notNullable().defaultTo(0);
        t.uuid('locked_by').nullable();
        t.timestamp('locked_until', { useTz: true }).nullable();
        t.string('receipt_id', 255).nullable();
        t.string('ultimo_erro', 80).nullable();
        t.timestamp('criado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('atualizado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('recebido_em', { useTz: true }).nullable();
        t.index(['status', 'locked_until']);
    });
    await knex.raw(`ALTER TABLE infinitepay_entregas_operacionais
        ADD CONSTRAINT ip_delivery_status CHECK (status IN ('PENDENTE','ENVIANDO','INCERTA','RECEBIDA')),
        ADD CONSTRAINT ip_delivery_attempts CHECK (tentativas >= 0),
        ADD CONSTRAINT ip_delivery_destination CHECK (destino ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
        ADD CONSTRAINT ip_delivery_lease CHECK ((status = 'ENVIANDO' AND locked_by IS NOT NULL AND locked_until IS NOT NULL)
            OR (status <> 'ENVIANDO' AND locked_by IS NULL AND locked_until IS NULL)),
        ADD CONSTRAINT ip_delivery_receipt CHECK ((status = 'RECEBIDA' AND receipt_id IS NOT NULL AND recebido_em IS NOT NULL)
            OR (status <> 'RECEBIDA' AND receipt_id IS NULL AND recebido_em IS NULL)),
        ADD CONSTRAINT ip_delivery_receipt_nonempty CHECK (receipt_id IS NULL OR btrim(receipt_id) <> '')`);
    await knex.schema.createTable('infinitepay_entregas_tentativas', t => {
        t.bigIncrements('id');
        t.text('chave_unica').notNullable().references('chave_unica').inTable('infinitepay_entregas_operacionais').onDelete('RESTRICT');
        t.integer('numero').notNullable();
        t.uuid('token').notNullable().unique();
        t.string('operacao', 20).notNullable();
        t.string('status', 20).notNullable();
        t.string('ultimo_erro', 80).nullable();
        t.timestamp('iniciado_em', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('finalizado_em', { useTz: true }).nullable();
        t.unique(['chave_unica', 'numero']);
    });
    await knex.raw(`ALTER TABLE infinitepay_entregas_tentativas
        ADD CONSTRAINT ip_delivery_audit_number CHECK (numero > 0),
        ADD CONSTRAINT ip_delivery_audit_operation CHECK (operacao IN ('ENVIO','RECUPERACAO')),
        ADD CONSTRAINT ip_delivery_audit_status CHECK (status IN ('ENVIANDO','INCERTA','RECEBIDA')),
        ADD CONSTRAINT ip_delivery_audit_finish CHECK ((status <> 'ENVIANDO') = (finalizado_em IS NOT NULL))`);
}

export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve dados e estrutura de entregas, recibos e tentativas auditáveis.');
}
