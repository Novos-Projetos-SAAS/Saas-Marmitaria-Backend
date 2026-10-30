import 'dotenv/config'
import { isolatedTestConnection } from './src/config/isolatedTestDatabase.js';
import {resolveFinancialEnvironment} from './src/config/resolveFinancialEnvironment.js';
import {financialPostgresConnection} from './src/config/postgresConnection.js';

/** @type { Object.<string, import("knex").Knex.Config> } */
const env = resolveFinancialEnvironment(process.env);
Object.assign(process.env, env);
const financialProduction = env.NODE_ENV === 'production' && env.INFINITEPAY_MODE === 'production';
const databaseHost = env.DB_HOST;
const remoteDatabase = host => !['127.0.0.1','localhost','::1','[::1]'].includes(host);
const verifiedTls = {rejectUnauthorized: true, ...(env.DB_SSL_CA ? {ca:env.DB_SSL_CA} : {})};
const connection = env.DATABASE_URL
  ? financialProduction
    ? financialPostgresConnection(env.DATABASE_URL, {ca:env.DB_SSL_CA})
    : {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: false}}
  : {
      host: databaseHost,
      port: Number(env.DB_PORT || 5432),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      ...(financialProduction ? {ssl: remoteDatabase(databaseHost) ? verifiedTls : false} : {})
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
