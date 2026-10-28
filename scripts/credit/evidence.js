import { normalizedPayment } from '../../src/services/infinitepayCheckClient.js';
import { parseObservedPaymentCheck, parseObservedInfinitepayEvent, receiptMatchesTransaction } from '../../src/services/infinitepayObservedContracts.js';
import { digest } from './observations.js';

const blocked=()=>new Error('Evidência financeira H4 incompatível.');
export function creditProof(data,expected,amount) {
    if(data?.success!==true || data.paid!==true || data.amount!==amount || data.capture_method!=='credit_card' || data.installments!==1)throw blocked();
    return normalizedPayment(parseObservedPaymentCheck(data,expected),expected,new Set(['https://recibo.infinitepay.io']));
}

// Financial proof and receipt association have distinct sources; neither original payload is modified.
export function composeCreditEvidence({data,expected,amount,callbacks=[],returnNonceHash}) {
    const financial=creditProof(data,expected,amount),candidates=[];
    let invalid=false;
    if(financial.receiptUrl)candidates.push({url:financial.receiptUrl,source:'PAYMENT_CHECK'});
    for(const callback of callbacks){
        const raw=callback.raw;
        if(raw?.order_nsu!==expected.orderNsu || raw.receipt_url===undefined)continue;
        try{
            let transaction,invoice;
            if(callback.kind==='RETURN'){
                if(typeof raw.r!=='string' || digest(raw.r)!==returnNonceHash ||
                    (raw.invoice_slug!==undefined && raw.slug!==undefined && raw.invoice_slug!==raw.slug))throw blocked();
                transaction=raw.transaction_nsu;invoice=raw.slug??raw.invoice_slug;
            }else if(callback.kind==='WEBHOOK'){
                const parsed=parseObservedInfinitepayEvent(raw);transaction=parsed.transactionNsu;invoice=parsed.invoiceSlug;
            }else throw blocked();
            if(transaction!==expected.transactionNsu || invoice!==expected.invoiceSlug ||
                (raw.capture_method!==undefined && raw.capture_method!==financial.captureMethod) ||
                !receiptMatchesTransaction(raw.receipt_url,expected.transactionNsu))throw blocked();
            candidates.push({url:raw.receipt_url,source:'PERSISTED_'+callback.kind,reference:callback.reference});
        }catch{invalid=true;}
    }
    const urls=new Set(candidates.map(candidate=>candidate.url)),unique=new Map();
    for(const candidate of candidates)if(!unique.has(candidate.source+'\0'+candidate.url))unique.set(candidate.source+'\0'+candidate.url,candidate);
    const references=[...unique.values()].sort((a,b)=>a.source.localeCompare(b.source));
    const status=invalid || urls.size>1?'BLOCKED':urls.size===1?'VALIDATED':'ABSENT';
    const receipt={status,...(status==='VALIDATED'?{url:[...urls][0]}:{}),
        sources:status==='VALIDATED'?[...new Set(references.map(item=>item.source))]:[],references};
    const sources=Object.fromEntries(['success','paid','amount','paid_amount','capture_method','installments'].map(field=>[field,'PAYMENT_CHECK_HTTP_200']));
    Object.assign(sources,{order_nsu:'RESERVATION_AND_CHECK_REQUEST_CONTEXT',transaction_nsu:'CORRELATED_CALLBACKS_AND_CHECK_REQUEST_CONTEXT',
        slug:'CORRELATED_CALLBACKS_AND_CHECK_REQUEST_CONTEXT',receipt_url:receipt.sources});
    return {financial,receipt,reconciliationReady:status!=='BLOCKED',sources,
        providerEchoFields:['order_nsu','transaction_nsu','slug','invoice_slug'].filter(field=>Object.hasOwn(data,field)),
        receiptValidation:'ALLOWED_HTTPS_ORIGIN_AND_EXACT_TRANSACTION_PATH',callbackSignatureVerified:false};
}
