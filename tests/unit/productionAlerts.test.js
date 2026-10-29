import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildProductionAlerts} from '../../src/services/productionAlerts.js';
function sample(){return {worker:{running:true,stalled:false,lastCycleErrors:0},financial:{uncertain:0,uncertainOverdue:0,divergent:0,eventsExhausted:0,eventsFailed:0,refundSignalsPending:0,manualRefundsPending:0},
    outbox:{failed:0,overdue:0,exhausted:0},deliveries:{uncertain:0},administration:{auditPending:false,pendingSessionAudits:0,pendingRevocationAudits:0},
    supervision:{workerExpected:false,missingCapabilities:[],expiringApprovals:0}};}
test('quiet prepared operation has no alert and never implies commercial readiness',()=>{assert.deepEqual(buildProductionAlerts(sample()),[]);});
test('uncertainty, divergence, exhausted queues, refunds and supervision generate sanitized actionable codes',()=>{
    const s=sample();Object.assign(s.financial,{uncertain:2,uncertainOverdue:1,divergent:1,eventsExhausted:3,refundSignalsPending:1,manualRefundsPending:1});
    s.outbox.exhausted=1;s.deliveries.uncertain=1;s.administration.auditPending=true;s.supervision={workerExpected:true,missingCapabilities:['WORKER'],expiringApprovals:1};s.worker.running=false;
    const alerts=buildProductionAlerts(s),codes=alerts.map(a=>a.code);
    for(const code of ['UNCERTAIN_OVERDUE','AMOUNT_DIVERGENCE','EVENTS_EXHAUSTED','OUTBOX_EXHAUSTED','REFUND_PROOF_PENDING','MANUAL_REFUNDS_PENDING','AUTHORIZATION_REQUIRED','AUTHORIZATION_EXPIRING','WORKER_STOPPED','AUDIT_PENDING'])assert.ok(codes.includes(code),code);
    assert.equal(alerts.every(a=>Object.keys(a).sort().join(',')==='code,count,severity'),true);
    assert.doesNotMatch(JSON.stringify(alerts),/order_nsu|receipt_url|token|api_key|SYNTHETIC_SECRET/);
});
test('invalid observation fails instead of reporting a healthy zero',()=>{const s=sample();s.financial.uncertain=NaN;assert.throws(()=>buildProductionAlerts(s));});
test('an empty cycle during backoff does not clear persisted queue alerts',()=>{const s=sample();s.outbox.failed=1;s.financial.eventsFailed=1;
    const codes=buildProductionAlerts(s).map(a=>a.code);assert.ok(codes.includes('OUTBOX_FAILED'));assert.ok(codes.includes('EVENTS_PENDING_REVIEW'));});
