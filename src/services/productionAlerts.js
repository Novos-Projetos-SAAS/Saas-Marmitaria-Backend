export function buildProductionAlerts(snapshot) {
    const {financial:f,outbox:o,deliveries:d,administration:a,worker:w,supervision:s}=snapshot,alerts=[];
    const add=(code,severity,count)=>{
        if(!Number.isSafeInteger(count) || count<0)throw new Error('Observação de alertas indisponível.');
        if(count)alerts.push({code,severity,count});
    };
    add('UNCERTAIN_PAYMENTS','warning',f.uncertain);add('UNCERTAIN_OVERDUE','critical',f.uncertainOverdue);
    add('AMOUNT_DIVERGENCE','critical',f.divergent);add('EVENTS_EXHAUSTED','critical',f.eventsExhausted);
    add('EVENTS_PENDING_REVIEW','warning',f.eventsFailed);
    add('REFUND_PROOF_PENDING','warning',f.refundSignalsPending);add('MANUAL_REFUNDS_PENDING','warning',f.manualRefundsPending);
    add('OUTBOX_FAILED','warning',o.failed);add('OUTBOX_OVERDUE','critical',o.overdue);add('OUTBOX_EXHAUSTED','critical',o.exhausted);
    add('DELIVERY_UNCERTAIN','critical',d.uncertain);
    add('AUDIT_PENDING','critical',Number(Boolean(a.auditPending))+a.pendingSessionAudits+a.pendingRevocationAudits);
    add('WORKER_STOPPED','critical',Number(s.workerExpected && !w.running));add('WORKER_STALLED','critical',Number(s.workerExpected && w.stalled));
    add('PROCESSING_ERRORS','warning',w.lastCycleErrors);
    add('AUTHORIZATION_REQUIRED','critical',s.missingCapabilities.length);add('AUTHORIZATION_EXPIRING','warning',s.expiringApprovals);
    return alerts;
}
