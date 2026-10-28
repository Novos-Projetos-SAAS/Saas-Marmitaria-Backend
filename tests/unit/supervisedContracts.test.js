import {test} from 'node:test';
import assert from 'node:assert/strict';

const shift={enabled:false,shiftSeconds:14400,maxShiftSeconds:28800,leaseSeconds:300,supervisionSeconds:60};
const sample={now:1000,shiftStartedAt:0,leaseStartedAt:0,lastSupervisedAt:0,humanApprovedLease:true,
    processApproved:true,capabilities:['WORKER','VERIFY_PAYMENT'],operation:'VERIFY_PAYMENT',revoked:false,stopped:false};
test('shift contract is only a proposal and never enables production or chooses default shift duration',async()=>{
    const {prepareSupervisedShiftContract,evaluateSupervisedShift}=await import('../../src/services/supervisedShiftContract.js');
    const contract=prepareSupervisedShiftContract(shift),result=evaluateSupervisedShift(contract,sample);
    assert.equal(contract.enabled,false);assert.equal(result.authorized,false);assert.equal(result.wouldAllow,true);
    for(const change of [{enabled:true},{shiftSeconds:undefined},{shiftSeconds:30000},{maxShiftSeconds:86401},{leaseSeconds:901},
        {supervisionSeconds:301},{unknown:true}])assert.throws(()=>prepareSupervisedShiftContract({...shift,...change}));
});
test('supervised model denies expiry, missing supervision, revocation, restart and implicit renewal',async()=>{
    const {prepareSupervisedShiftContract,evaluateSupervisedShift}=await import('../../src/services/supervisedShiftContract.js');
    const contract=prepareSupervisedShiftContract(shift);
    for(const change of [{now:300000,lastSupervisedAt:300000},{now:14400000,leaseStartedAt:14399999,lastSupervisedAt:14400000},
        {now:60000},{revoked:true},{stopped:true},{processApproved:false},{humanApprovedLease:false},{operation:'CREATE_LINK'}]) {
        const result=evaluateSupervisedShift(contract,{...sample,...change});assert.equal(result.wouldAllow,false);assert.equal(result.authorized,false);
    }
    assert.throws(()=>evaluateSupervisedShift(contract,{...sample,now:-1}));
});
test('human renewal can move a lease but cannot extend the original shift or authorize actual operations',async()=>{
    const {prepareSupervisedShiftContract,evaluateSupervisedShift}=await import('../../src/services/supervisedShiftContract.js');
    const contract=prepareSupervisedShiftContract(shift);
    assert.equal(evaluateSupervisedShift(contract,{...sample,now:400000,leaseStartedAt:399000,lastSupervisedAt:399000}).wouldAllow,true);
    const ended=evaluateSupervisedShift(contract,{...sample,now:14400000,leaseStartedAt:14399999,lastSupervisedAt:14400000});
    assert.equal(ended.wouldAllow,false);assert.equal(ended.authorized,false);
});
test('recipient policy separates authenticated receipt, employee confirmation and explicit audited reprint',async()=>{
    const {prepareOperationalRecipientContract}=await import('../../src/services/operationalDestinationContract.js');
    const proposal={stationId:'synthetic-kitchen-1',authentication:'AUTHENTICATED_RECEIPTS_REQUIRED',receiptRetentionSeconds:86400,
        maxRecoverySeconds:3600,employeePermission:'cozinha.confirmar',reprintPermission:'cozinha.reimprimir'};
    const result=prepareOperationalRecipientContract(proposal,'synthetic-kitchen-1');
    assert.equal(result.proposalOnly,true);assert.equal(result.physicalPrintingProven,false);assert.equal(result.reprintRequiresAudit,true);
    for(const change of [{stationId:'different'},{authentication:'NONE'},{receiptRetentionSeconds:100},{employeePermission:''},
        {reprintPermission:null},{printed:true}])assert.throws(()=>prepareOperationalRecipientContract({...proposal,...change},'synthetic-kitchen-1'));
});
