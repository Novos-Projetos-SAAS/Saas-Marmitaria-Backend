import { describe,before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../helpers/testDatabase.js';
import { prepareDemoProvider } from '../../scripts/demo/provider.js';

describe('demo bootstrap is durable across interrupted initialization',()=>{
    let fixture,db;
    before(async()=>{fixture=await createTestDatabase();db=fixture.db;});
    after(async()=>{await fixture?.close();});
    test('provider table and initial row roll back together and may be prepared again',async()=>{
        const interrupt=query=>{if(query.sql.startsWith('insert into "demo_provider_settings"'))throw new Error('SYNTHETIC_BOOTSTRAP_INTERRUPTION');};
        db.on('query',interrupt);
        try{await assert.rejects(prepareDemoProvider(db),/SYNTHETIC_BOOTSTRAP_INTERRUPTION/);}finally{db.removeListener('query',interrupt);}
        assert.equal(await db.schema.hasTable('demo_provider_settings'),false);
        await prepareDemoProvider(db);await prepareDemoProvider(db);
        assert.equal(Number((await db('demo_provider_settings').count('* as n').first()).n),1);
    });
    test('schema identity is created atomically, retries preserve it, and unidentified schemas remain refused',async()=>{
        const {prepareDemoSchema}=await import('../../scripts/demo/prepare.js');
        const schema=fixture.schema+'_bootstrap',purpose='SYNTHETIC_BOOTSTRAP_TEST';
        assert.match(schema,/^iptest_[a-f0-9]{32}_bootstrap$/);
        const exists=async()=>Boolean(await db('information_schema.schemata').where({schema_name:schema}).first());
        const interrupt=query=>{if(query.sql.includes('insert into "'+schema+'"."demo_identity"'))throw new Error('SYNTHETIC_IDENTITY_INTERRUPTION');};
        try {
            db.on('query',interrupt);
            try{await assert.rejects(prepareDemoSchema(db,schema,purpose),/SYNTHETIC_IDENTITY_INTERRUPTION/);}finally{db.removeListener('query',interrupt);}
            assert.equal(await exists(),false);
            await prepareDemoSchema(db,schema,purpose);await prepareDemoSchema(db,schema,purpose);
            assert.equal((await db('demo_identity').withSchema(schema).first()).purpose,purpose);
            await assert.rejects(prepareDemoSchema(db,fixture.schema,purpose),/identidade/);
            await assert.rejects(prepareDemoSchema(db,schema,'DIFFERENT_PURPOSE'),/identidade/);
        } finally {
            if(await exists())await db.schema.dropSchema(schema,true);
        }
    });
});
