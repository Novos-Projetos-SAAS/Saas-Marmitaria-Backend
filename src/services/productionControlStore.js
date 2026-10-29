// All mutations run inside the caller's authenticated transaction and installation lock.
export function createProductionControlStore({db,deploymentId,now}) {
    const scope={implantacao_id:deploymentId};
    const lock=(trx,shared=false)=>trx.raw(`SELECT pg_advisory_xact_lock${shared?'_shared':''}(hashtextextended(?,0))`,['infinitepay:production-control:'+deploymentId]);
    const read=(reader=db)=>reader('infinitepay_controle_producao').where(scope).first();
    const revoked=(hash,reader=db)=>reader('infinitepay_sessoes_revogadas').where({...scope,token_hash:hash}).first();
    async function ensure(trx) {
        await trx('infinitepay_controle_producao').insert({...scope,geracao:0}).onConflict('implantacao_id').ignore();return read(trx);
    }
    const audit=(trx,action,generation,actor,sessionHash=null,instant=now())=>trx('infinitepay_controle_acoes').insert({...scope,acao:action,geracao:generation,
        usuario_id:actor.id,sessao_hash:sessionHash,criado_em:instant});
    async function tryAudit(trx,...args) {
        try{await trx.transaction(savepoint=>audit(savepoint,...args));return true;}catch{return false;}
    }
    async function stop(trx,actor) {
        await ensure(trx);
        const [row]=await trx('infinitepay_controle_producao').where(scope).update({geracao:trx.raw('geracao+1'),parada_em:now(),parado_por:actor.id}).returning('*');
        await trx('infinitepay_paradas_producao').insert({...scope,geracao:row.geracao,usuario_id:actor.id,criado_em:row.parada_em});
        if(!await tryAudit(trx,'STOP',row.geracao,actor))return markPending(trx);
        return row;
    }
    async function markPending(trx) {
        const [row]=await trx('infinitepay_controle_producao').where(scope).update({auditoria_pendente:true}).returning('*');
        await trx('infinitepay_paradas_producao').where({...scope,geracao:row.geracao}).update({auditoria_pendente:true});return row;
    }
    async function recover(trx,actor,expectedGeneration) {
        const row=await read(trx);
        if(!row?.parada_em || String(row.geracao)!==String(expectedGeneration))return null;
        if(row.auditoria_pendente) {
            for(const pending of await trx('infinitepay_paradas_producao').where({...scope,auditoria_pendente:true}).orderBy('geracao')) {
                await audit(trx,'STOP',pending.geracao,{id:pending.usuario_id},null,pending.criado_em);
            }
            await trx('infinitepay_paradas_producao').where({...scope,auditoria_pendente:true}).update({auditoria_pendente:false});
        }
        const [next]=await trx('infinitepay_controle_producao').where({...scope,geracao:expectedGeneration})
            .update({geracao:trx.raw('geracao+1'),parada_em:null,parado_por:null,auditoria_pendente:false}).returning('*');
        await audit(trx,'RECOVER',next.geracao,actor);return next;
    }
    async function endSession(trx,actor) {
        const row=await ensure(trx),instant=now();
        await trx('infinitepay_sessoes_revogadas').insert({...scope,token_hash:actor.sessionHash,usuario_id:actor.id,revogado_em:instant,expira_em:actor.expiresAt})
            .onConflict(['implantacao_id','token_hash']).ignore();
        await trx('infinitepay_autorizacoes_producao').where({...scope,sessao_hash:actor.sessionHash}).whereNull('revogado_em').update({revogado_em:instant,revogado_por:actor.id});
        const logged=await tryAudit(trx,'SESSION_END',row.geracao,actor,actor.sessionHash);
        await trx('infinitepay_sessoes_revogadas').where({...scope,token_hash:actor.sessionHash}).update({auditoria_pendente:!logged});
        return {auditPending:!logged};
    }
    return {lock,read,revoked,ensure,stop,recover,endSession,markPending};
}
