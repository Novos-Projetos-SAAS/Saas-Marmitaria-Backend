import {buildProductionAlerts} from './productionAlerts.js';
export function createProductionDiagnostics({db,authorizer,application,now=()=>new Date(),overdueSeconds=300,environment={}}) {
    if(typeof db!=='function' || typeof authorizer?.status!=='function' || typeof application?.status!=='function' ||
        !Number.isSafeInteger(overdueSeconds) || overdueSeconds<1 || overdueSeconds>86400)throw new TypeError('Diagnóstico indisponível.');
    const revision=state=>JSON.stringify({halted:state.halted,generation:state.generation,auditPending:state.auditPending,
        approvals:state.approvals.map(row=>({id:row.id,expiresAt:row.expiresAt,revoked:row.revoked,auditPending:row.auditPending,
            capabilities:[...row.effectiveCapabilities].sort()})).sort((a,b)=>a.id.localeCompare(b.id))});
    async function read(request) {
        try {
            const control=await authorizer.status(request),worker=application.status(),instant=now();
            if(!(instant instanceof Date) || !Number.isFinite(instant.getTime()) || worker?.mode!=='production' || worker.prepared!==true ||
                typeof worker.running!=='boolean' || ![worker.cycles,worker.errors].every(value=>Number.isSafeInteger(value) && value>=0))throw new Error();
            return await db.transaction(async trx=>{
                await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
                const count=async(table,filter=()=>{})=>Number((await trx(table).modify(filter).count('* as n').first()).n);
                const pending=table=>count(table,q=>q.whereNotIn('status',['CONCLUIDO']));
                const snapshot={observedAt:instant.toISOString(),storageAvailable:true,commercialReady:false,
                    worker:{running:worker.running,cycles:worker.cycles,errors:worker.errors,lastCycleAt:worker.lastCycleAt || null,
                        lastCycleErrors:worker.lastCycleErrors || 0,stalled:worker.running && Boolean(worker.lastCycleAt || worker.startedAt) &&
                            instant-new Date(worker.lastCycleAt || worker.startedAt)>overdueSeconds*1000},
                    financial:{pending:await count('pagamentos',q=>q.whereIn('status',['CRIANDO','AGUARDANDO','INCERTA'])),
                        uncertain:await count('pagamentos',q=>q.where({status:'INCERTA'})),
                        divergent:await count('pagamentos',q=>q.where({status:'DIVERGENTE'})),
                        uncertainOverdue:await count('pagamentos',q=>q.where({status:'INCERTA'}).where('criado_em','<',new Date(instant.getTime()-overdueSeconds*1000))),
                        oldestUncertainAt:(await trx('pagamentos').where({status:'INCERTA'}).min('criado_em as oldest').first()).oldest ?? null,
                        eventsPending:await count('pagamentos_eventos',q=>q.whereNot('status_processamento','CONCLUIDO')),
                        eventsExhausted:await count('pagamentos_eventos',q=>q.whereNot('status_processamento','CONCLUIDO').where('tentativas','>=',5)),
                        eventsFailed:await count('pagamentos_eventos',q=>q.whereNot('status_processamento','CONCLUIDO').whereNotNull('ultimo_erro').whereNot('ultimo_erro','PAYMENT_NOT_CONFIRMED')),
                        refundSignalsPending:await count('pagamentos_eventos',q=>q.where({tipo_evento:'refunded'}).whereNot('status_processamento','CONCLUIDO')),
                        manualRefundsPending:await count('pagamentos_eventos as r',q=>q.where('r.tipo_evento','ADMIN_ESTORNO_SOLICITADO').whereNotExists(function(){
                            this.select(1).from('pagamentos_eventos as c').where('c.tipo_evento','ADMIN_ESTORNO_CONCILIACAO')
                                .whereRaw("c.payload_filtrado->>'estorno_id' = r.payload_filtrado->>'estorno_id'")
                                .whereRaw("c.payload_filtrado->'resultado'->>'estado' = 'CONFIRMADO_POR_EVIDENCIA'");
                        }))},
                    outbox:{pending:await pending('outbox_eventos'),failed:await count('outbox_eventos',q=>q.where({status:'ERRO'})),exhausted:await count('outbox_eventos',q=>q.whereNot('status','CONCLUIDO').where('tentativas','>=',5)),overdue:await count('outbox_eventos',q=>q.whereNot('status','CONCLUIDO')
                        .where('criado_em','<',new Date(instant.getTime()-overdueSeconds*1000)))},
                    deliveries:{uncertain:await count('infinitepay_entregas_operacionais',q=>q.where({status:'INCERTA'}))},
                    administration:{stopped:control.halted,auditPending:control.auditPending,
                        effectiveApprovals:control.approvals.filter(row=>row.effectiveCapabilities.length>0).length,
                        revokedApprovals:await count('infinitepay_autorizacoes_producao',q=>q.whereNotNull('revogado_em')),
                        revokedSessions:await count('infinitepay_sessoes_revogadas'),stops:await count('infinitepay_paradas_producao'),
                        pendingSessionAudits:await count('infinitepay_sessoes_revogadas',q=>q.where({auditoria_pendente:true})),
                        pendingRevocationAudits:await count('infinitepay_autorizacoes_producao',q=>q.where({revogacao_auditoria_pendente:true})),
                        credentialErrors:await count('infinitepay_autorizacao_decisoes',q=>q.whereIn('codigo',['CREDENTIAL_INVALID','AUTHORIZATION_UNAVAILABLE']))}};
                const effective=new Set(control.approvals.flatMap(row=>row.effectiveCapabilities));
                const flags={WORKER:'INFINITEPAY_WORKER_ENABLED',VERIFY_PAYMENT:'INFINITEPAY_VERIFY_ENABLED',DELIVER_ORDER:'INFINITEPAY_DELIVERY_ENABLED',CREATE_LINK:'INFINITEPAY_CHECKOUT_ENABLED'};
                snapshot.supervision={workerExpected:environment.INFINITEPAY_WORKER_ENABLED==='true',automaticRenewal:false,
                    missingCapabilities:Object.keys(flags).filter(cap=>environment[flags[cap]]==='true' && !effective.has(cap)),
                    expiringApprovals:control.approvals.filter(row=>row.effectiveCapabilities.length && new Date(row.expiresAt)-instant<=60000).length};
                snapshot.alerts=buildProductionAlerts(snapshot);
                // A control mutation crossing the metrics snapshot must never look like a healthy, stable observation.
                if(revision(control)!==revision(await authorizer.status(request)))throw new Error('Observação administrativa mudou.');
                return snapshot;
            });
        }catch(error){throw Object.assign(new Error('Diagnóstico administrativo indisponível.'),{code:error.code==='ADMINISTRATION_DENIED'?'ADMINISTRATION_DENIED':'DIAGNOSTICS_UNAVAILABLE',statusCode:error.code==='ADMINISTRATION_DENIED'?403:503});}
    }
    return {read};
}
