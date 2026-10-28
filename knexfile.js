import 'dotenv/config'
import { isolatedTestConnection } from './src/config/isolatedTestDatabase.js';

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */

const financialProduction=process.env.NODE_ENV === 'production' && process.env.INFINITEPAY_MODE === 'production';
const databaseHost=process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.DB_HOST;
const financialTls=financialProduction && !['127.0.0.1','localhost','::1','[::1]'].includes(databaseHost)
  ? {rejectUnauthorized:true,...(process.env.DB_SSL_CA ? {ca:process.env.DB_SSL_CA} : {})} : false;
const connection = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: financialProduction ? financialTls : { rejectUnauthorized: false } // Legacy profile; financial production verifies TLS.
    }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ...(financialProduction ? {ssl:financialTls} : {})
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
