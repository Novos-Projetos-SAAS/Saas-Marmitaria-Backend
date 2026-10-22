import 'dotenv/config'
import { isolatedTestConnection } from './src/config/isolatedTestDatabase.js';

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */

const connection = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false } // necessário pra Neon
    }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    };

export default {
  ...(process.env.NODE_ENV === 'test' ? {
    test: { client: 'pg', connection: isolatedTestConnection(),
      migrations: { directory: './src/database/migrations' } }
  } : {}),
  development: {
    client: 'pg',
    connection,
    migrations: {
      directory: './src/database/migrations'
    },
    seeds: {
      directory: './src/database/seeds'
    }
  },

  production: {
    client: 'pg',
    connection,
    migrations: {
      directory: './src/database/migrations'
      },
    seeds: {
      directory: './src/database/seeds'
    }
  }
};
