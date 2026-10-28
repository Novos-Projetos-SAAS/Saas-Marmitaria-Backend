import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfinitepayEnvironment } from '../../src/infinitepayApplication.js';

import { syntheticProductionEnvironment } from '../helpers/productionEnvironment.js';
import { assertProductionDatabase } from '../../src/config/infinitepayProduction.js';
const productionEnv=syntheticProductionEnvironment();
test('production preparation is explicit and stays disabled without creation and worker flags', () => {
    assert.equal(validateInfinitepayEnvironment({NODE_ENV:'production'}), null);
    const config=validateInfinitepayEnvironment(productionEnv);
    assert.equal(config.mode,'production');
    assert.equal(config.databaseId,productionEnv.INFINITEPAY_DATABASE_ID);
});
test('production refuses a different configured connection before issuing SQL',async()=>{
    const config=validateInfinitepayEnvironment(productionEnv);let sql=0;
    for(const connection of [{host:'other.invalid.test',database:config.database,port:config.port},
        {host:config.host,database:'other',port:config.port},
        {host:config.host,database:config.database,port:5432}]) {
        await assert.rejects(assertProductionDatabase({client:{config:{connection}},raw:async()=>{sql++;}},config));
    }
    assert.equal(sql,0);
});
test('remote production database refuses disabled certificate validation before issuing SQL',async()=>{
    const config=validateInfinitepayEnvironment({...productionEnv,DB_HOST:'db.invalid.test'});let sql=0;
    await assert.rejects(assertProductionDatabase({client:{config:{connection:{host:config.host,database:config.database,port:config.port,
        ssl:{rejectUnauthorized:false}}}},raw:async()=>{sql++;}},config));
    assert.equal(sql,0);
});
test('connection-string options cannot override the approved TLS configuration',async()=>{
    const config=validateInfinitepayEnvironment({...productionEnv,DB_HOST:'db.invalid.test'});let sql=0;
    await assert.rejects(assertProductionDatabase({client:{config:{connection:{connectionString:
        'postgresql://synthetic@db.invalid.test:55439/infinitepay_phase1_test?sslmode=disable',ssl:{rejectUnauthorized:true}}}},
        raw:async()=>{sql++;return {rows:[{name:config.database}]};}},config));
    assert.equal(sql,0);
});
test('financial production Knex profile requires TLS certificate verification for a remote database',async()=>{
    const keys=['NODE_ENV','INFINITEPAY_MODE','DATABASE_URL'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    try {
        process.env.NODE_ENV='production';process.env.INFINITEPAY_MODE='production';process.env.DATABASE_URL='postgresql://synthetic@db.invalid.test/marmitaria';
        const {default:config}=await import('../../knexfile.js?production-tls-test');
        assert.equal(config.production.connection.ssl.rejectUnauthorized,true);
    } finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('production preparation rejects wrong mode, identity, HTTP, absent proxy and demo mixing', () => {
    for(const extra of [{NODE_ENV:'development'},{INFINITEPAY_DATABASE_ID:''},{INFINITEPAY_DATABASE_ID:'unknown'},
        {INFINITEPAY_PUBLIC_ORIGIN:'http://backend.invalid.test'},{INFINITEPAY_TRUSTED_PROXY_IPS:''},
        {INFINITEPAY_TRUSTED_PROXY_IPS:'0.0.0.0/0'},{INFINITEPAY_DEMO:'local-only'},
        {INFINITEPAY_DATABASE_NAME:'infinitepay_credit_homologacao',DB_NAME:'infinitepay_credit_homologacao'},
        {INFINITEPAY_DATABASE_NAME:'infinitepay_h1_homologacao',DB_NAME:'infinitepay_h1_homologacao'}]) {
        assert.throws(()=>validateInfinitepayEnvironment({...productionEnv,...extra}));
    }
});
