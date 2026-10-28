export async function up(knex) {
    await knex.schema.createTable('infinitepay_identidade_ambiente',table=>{
        table.integer('id').primary().defaultTo(1);
        table.uuid('identidade').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
        table.string('ambiente',20).notNullable().defaultTo('NAO_CONFIGURADO');
        table.timestamp('criado_em',{useTz:true}).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw("ALTER TABLE infinitepay_identidade_ambiente ADD CONSTRAINT ip_environment_singleton CHECK(id=1), ADD CONSTRAINT ip_environment_kind CHECK(ambiente IN ('NAO_CONFIGURADO','HOMOLOGACAO','PRODUCAO'))");
    // A migration never declares or activates production on behalf of the operator.
    await knex('infinitepay_identidade_ambiente').insert({id:1});
}
export async function down() {
    throw new Error('Rollback bloqueado (forward-only): preserve dados e estrutura da identidade da implantação.');
}
