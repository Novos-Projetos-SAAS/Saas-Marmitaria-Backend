import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
export const migrations = fileURLToPath(new URL('../../src/database/migrations/', import.meta.url));
export async function migrateBaseline(db) {
    const names = (await readdir(migrations)).filter(name => name.endsWith('.js') && name < '20261022').sort();
    for (const name of names) await db.migrate.up({ name });
}
export async function historicalOrder(db, { id = 1, methodId = 17 } = {}) {
    await db('metodos_pagamento').insert({ id: methodId, nome: 'Método sintético ' + methodId });
    const [size] = await db('tamanhos_marmitas').insert({ nome: 'M sintética '+id, preco_base: 20 }).returning('*');
    const [order] = await db('pedidos').insert({ id, nome_cliente: 'Cliente sintético', telefone_cliente: '11999999999',
        endereco_cliente: 'Endereço sintético', tipo_pedido: 'Remoto', metodo_entrega: 'Entrega',
        metodo_pagamento_id: methodId, status: 'Pendente', valor_total: 20 }).returning('*');
    await db('itens_pedido').insert({ pedido_id: id, tamanho_marmita_id: size.id, quantidade: 1, preco_unitario: 20, subtotal: 20 });
    return order;
}
export function testConnection(value = process.env.TEST_DATABASE_URL) {
    if (!value) throw new Error('TEST_DATABASE_URL obrigatório: PostgreSQL local e descartável.');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/infinitepay_[a-z0-9_]*test$/.test(url.pathname) ||
        url.search || url.hash) throw new Error('Banco de teste recusado: use loopback e nome infinitepay_*test.');
    return { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password), database: url.pathname.slice(1), ssl: false };
}
export async function createTestDatabase() {
    const config = testConnection();
    const admin = knex({ client: 'pg', connection: config });
    const schema = 'iptest_' + randomUUID().replaceAll('-', '');
    await admin.raw('CREATE SCHEMA ??', [schema]);
    const db = knex({ client: 'pg', connection: config, searchPath: [schema], pool: { min: 0, max: 6 },
        migrations: { directory: migrations, schemaName: schema } });
    return { db, schema, async close() {
        await db.destroy();
        await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
        await admin.destroy();
    } };
}
