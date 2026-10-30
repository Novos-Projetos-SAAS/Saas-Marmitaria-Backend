import test from 'node:test';
import assert from 'node:assert/strict';
import {
    INFINITEPAY_ADMIN_SEED_PERMISSIONS,
    resolveInfinitepayAdminSeedTarget
} from '../src/utils/infinitepayAdminSeedPolicy.js';

test('targeted admin bootstrap requires explicit user selection and matching confirmation',()=>{
    assert.equal(resolveInfinitepayAdminSeedTarget({
        SEED_INFINITEPAY_ADMIN_USER_ID:'1',
        SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_1'
    }),1);
    assert.equal(resolveInfinitepayAdminSeedTarget({
        SEED_INFINITEPAY_ADMIN_USER_ID:'42',
        SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_42'
    }),42);
});

test('does not implicitly promote user 1 or accept mismatched confirmation',()=>{
    for(const environment of [
        {},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'1'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'1',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_2'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'0',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_0'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'-1',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_-1'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'1 OR 1=1',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_1'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'001',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_1'},
        {SEED_INFINITEPAY_ADMIN_USER_ID:'99999999999999999999999',SEED_INFINITEPAY_ADMIN_CONFIRM:'PROMOVER_USUARIO_99999999999999999999999'}
    ]) assert.throws(()=>resolveInfinitepayAdminSeedTarget(environment));
});

test('bootstrapped user gets RBAC administration and InfinitePay capability approval permission',()=>{
    assert.deepEqual([...INFINITEPAY_ADMIN_SEED_PERMISSIONS],[
        'permissoes.listar','permissoes.visualizar','permissoes.editar',
        'pagamentos.configurar','pagamentos.visualizar','pagamentos.conciliar',
        'pagamentos.ativar_producao'
    ]);
    assert.equal(new Set(INFINITEPAY_ADMIN_SEED_PERMISSIONS).size,
        INFINITEPAY_ADMIN_SEED_PERMISSIONS.length);
});
