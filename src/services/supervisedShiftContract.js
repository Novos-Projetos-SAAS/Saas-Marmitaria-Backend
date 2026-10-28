const capabilities=new Set(['WORKER','CREATE_LINK','VERIFY_PAYMENT','DELIVER_ORDER']);
const contracts=new WeakSet();
const invalid=()=>{throw new TypeError('Contrato supervisionado inválido.');};
function exact(value,keys) {
    if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key)))invalid();
}
const positive=value=>Number.isSafeInteger(value) && value>0;

// Proposal/simulation only: this module is never an authorizer or a runtime policy.
export function prepareSupervisedShiftContract(proposal) {
    exact(proposal,['enabled','shiftSeconds','maxShiftSeconds','leaseSeconds','supervisionSeconds']);
    const {enabled,shiftSeconds,maxShiftSeconds,leaseSeconds,supervisionSeconds}=proposal;
    if(enabled!==false || ![shiftSeconds,maxShiftSeconds,leaseSeconds,supervisionSeconds].every(positive) ||
        shiftSeconds>maxShiftSeconds || maxShiftSeconds>86400 || leaseSeconds>900 || leaseSeconds>shiftSeconds || supervisionSeconds>leaseSeconds)invalid();
    const contract=Object.freeze({...proposal,proposalOnly:true,humanRenewalRequired:true,restartRequiresNewApproval:true});
    contracts.add(contract);return contract;
}
export function evaluateSupervisedShift(contract,sample) {
    if(!contracts.has(contract))invalid();
    exact(sample,['now','shiftStartedAt','leaseStartedAt','lastSupervisedAt','humanApprovedLease','processApproved','capabilities','operation','revoked','stopped']);
    const {now,shiftStartedAt,leaseStartedAt,lastSupervisedAt}=sample;
    if(![now,shiftStartedAt,leaseStartedAt,lastSupervisedAt].every(value=>Number.isSafeInteger(value) && value>=0) ||
        now<shiftStartedAt || leaseStartedAt<shiftStartedAt || lastSupervisedAt<shiftStartedAt || leaseStartedAt>now || lastSupervisedAt>now ||
        ['humanApprovedLease','processApproved','revoked','stopped'].some(key=>typeof sample[key]!=='boolean') ||
        !Array.isArray(sample.capabilities) || new Set(sample.capabilities).size!==sample.capabilities.length ||
        sample.capabilities.some(value=>!capabilities.has(value)) || !capabilities.has(sample.operation))invalid();
    const reason=sample.stopped?'STOPPED':sample.revoked?'REVOKED':!sample.processApproved?'RESTART_APPROVAL_REQUIRED':
        !sample.humanApprovedLease?'HUMAN_APPROVAL_REQUIRED':now-shiftStartedAt>=contract.shiftSeconds*1000?'SHIFT_EXPIRED':
        now-leaseStartedAt>=contract.leaseSeconds*1000?'LEASE_EXPIRED':now-lastSupervisedAt>=contract.supervisionSeconds*1000?'SUPERVISION_EXPIRED':
        !sample.capabilities.includes('WORKER') || !sample.capabilities.includes(sample.operation)?'CAPABILITY_DENIED':'PROPOSED_ALLOWED';
    return Object.freeze({authorized:false,proposalOnly:true,wouldAllow:reason==='PROPOSED_ALLOWED',reason});
}
