import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createTestDatabase, migrations } from '../helpers/testDatabase.js';
import { readCreditDatabase } from '../../scripts/credit/diagnose.js';
import { createCreditControl } from '../../scripts/credit/control.js';
import { prepareCreditProbe } from '../../scripts/credit/preflight.js';

let fixture,db,profile,expectedMigrations;
const origin='https://synthetic-readonly.trycloudflare.com';
before(async()=>{
    fixture=await createTestDatabase();db=fixture.db;await db.migrate.latest();
    profile={purpose:'INFINITEPAY_CREDIT_PREPARATION_ONLY',host:'127.0.0.1',port:55439,database:'infinitepay_phase1_test'};
    await db.schema.createTable('credit_identity',table=>{table.integer('id').primary();table.text('purpose').notNullable();});
    await db('credit_identity').insert({id:1,purpose:profile.purpose});
    const key=randomBytes(32);await createCreditControl({db,captureKey:key,publicOrigin:origin}).pinOrigin();
    await prepareCreditProbe({db,captureKey:key});
    expectedMigrations=(await readdir(migrations)).filter(name=>name.endsWith('.js'));
});
after(async()=>{await fixture?.close();});
const read=(patch={})=>readCreditDatabase({db,profile,expectedMigrations,publicOrigin:origin,...patch});
const snapshot=async()=>Object.fromEntries(await Promise.all(['pagamentos','pagamentos_eventos','pedidos','itens_pedido','config_infinitepay','infinitepay_credenciais','outbox_eventos'].map(async table=>[table,await db(table).orderBy('id')])));

test('H4 diagnosis queries a coherent read-only PostgreSQL snapshot and preserves every financial row',async()=>{
    const before=await snapshot(),queries=[],listener=event=>queries.push(event.sql);db.on('query',listener);
    let result;try{result=await read();}finally{db.removeListener('query',listener);}
    assert.equal(result.identity,true);assert.equal(result.migrations,true);assert.equal(result.disabled,true);assert.equal(result.pinned,true);
    assert.equal(result.reserved,false);assert.equal(result.attempt_status,null);assert.equal(result.real_link_dispatches,0);assert.equal(result.real_check_dispatches,0);
    assert.equal(result.non_probe_attempts,0);assert.equal(result.provider_observations,0);assert.equal(result.financial_confirmation,false);assert.equal(result.kitchen_released,false);
    assert.deepEqual(result.attempts_by_status,[{status:'FALHOU',total:1}]);
    assert.ok(queries.some(sql=>/REPEATABLE READ READ ONLY/.test(sql)));
    assert.ok(queries.every(sql=>/^(select|set|begin|commit)/i.test(sql.trim())),JSON.stringify(queries));
    assert.deepEqual(await snapshot(),before);
});
test('H4 diagnosis stops before financial tables when actual database or purpose differs',async()=>{
    assert.deepEqual(await read({profile:{...profile,database:'infinitepay_credit_homologacao'}}),{identity:false});
    assert.deepEqual(await read({profile:{...profile,purpose:'WRONG_PURPOSE'}}),{identity:false});
});
test('H4 diagnosis identifies a migration mismatch before assuming a financial schema is ready',async()=>{
    assert.deepEqual(await read({expectedMigrations:[...expectedMigrations,'20990101000000_missing.js']}),{identity:true,migrations:false});
});
test('H4 diagnosis reports the fee absorption configuration required by creation without changing it',async()=>{
    try{
        await db('config_infinitepay').where({id:1}).update({assured_installments:2});
        assert.equal((await read()).one_installment,false);
        assert.equal((await db('config_infinitepay').where({id:1}).first()).assured_installments,2);
    }finally{await db('config_infinitepay').where({id:1}).update({assured_installments:1});}
});
test('H4 diagnosis will not exclude a preflight attempt that unexpectedly became potentially payable',async()=>{
    const payment=await db('pagamentos').first('id');
    try{
        await db('pagamentos').where({id:payment.id}).update({status:'INCERTA',bloqueia_nova_cobranca:true});
        assert.equal((await read()).non_probe_attempts,1);
    }finally{await db('pagamentos').where({id:payment.id}).update({status:'FALHOU',bloqueia_nova_cobranca:false});}
});
test('H4 diagnosis does not declare financial proof from a paid status without the bound verified attempt',async()=>{
    const payment=await db('pagamentos').first('id');
    try{
        await db('pagamentos').where({id:payment.id}).update({status:'PAGA'});
        const result=await read();assert.equal(result.financial_confirmation,false);assert.equal(result.non_probe_attempts,1);
    }finally{await db('pagamentos').where({id:payment.id}).update({status:'FALHOU'});}
});
