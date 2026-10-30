import test from 'node:test';
import assert from 'node:assert/strict';
import {changedFinancialPrivileges,FINANCIAL_PRIVILEGED_PERMISSIONS}
    from '../src/utils/financialPermissionChanges.js';

test('sensitive financial grants require a fresh administrator check',()=>{
    assert.deepEqual(changedFinancialPrivileges([],['pagamentos.ativar_producao']),['pagamentos.ativar_producao']);
    assert.deepEqual(changedFinancialPrivileges([],['pagamentos.configurar']),['pagamentos.configurar']);
    assert.deepEqual(changedFinancialPrivileges([],['pagamentos.conciliar']),['pagamentos.conciliar']);
    assert.deepEqual(changedFinancialPrivileges([],FINANCIAL_PRIVILEGED_PERMISSIONS),FINANCIAL_PRIVILEGED_PERMISSIONS);
});

test('financial privilege revocations are equally protected',()=>{
    assert.deepEqual(changedFinancialPrivileges(['pagamentos.ativar_producao'],[]),['pagamentos.ativar_producao']);
});

test('unrelated RBAC changes do not trigger a financial role check',()=>{
    assert.deepEqual(changedFinancialPrivileges(['pagamentos.configurar','usuarios.listar'],
        ['pagamentos.configurar','usuarios.editar']),[]);
    assert.deepEqual(changedFinancialPrivileges([],['pagamentos.visualizar']),[]);
});
