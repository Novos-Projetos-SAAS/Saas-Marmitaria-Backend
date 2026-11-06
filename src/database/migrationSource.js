import { readdir } from 'node:fs/promises';
import knex from 'knex';

const directory = new URL('./migrations/', import.meta.url);
const historicalDirectory = new URL('./migrations/historical/', import.meta.url);

export class HistoricalMigrationSource {
    constructor(connection) { this.connection = connection; }

    async getMigrations() {
        const current = (await readdir(directory)).filter(name => name.endsWith('.js'));
        const archived = new Set((await readdir(historicalDirectory)).filter(name => name.endsWith('.js')));
        const db = knex({ client: 'pg', connection: this.connection, pool: { min: 0, max: 1 } });
        try {
            const completed = await db.schema.hasTable('knex_migrations')
                ? await db('knex_migrations').select('name') : [];
            // Historical migrations remain visible to Knex only on databases that already ran them.
            return [
                ...current.map(name => ({ name, historical: false })),
                ...completed.filter(row => archived.has(row.name)).map(row => ({ name: row.name, historical: true }))
            ].sort((a, b) => a.name.localeCompare(b.name));
        } finally { await db.destroy(); }
    }

    getMigrationName(migration) { return migration.name; }
    getMigration(migration) {
        const root = migration.historical ? historicalDirectory : directory;
        return import(new URL(encodeURIComponent(migration.name), root).href);
    }
}
