import { createInterface } from 'node:readline/promises';
export async function confirmCreditOperation({operation,amount,publicOrigin,input=process.stdin,output=process.stdout}) {
    if(!input.isTTY || !output.isTTY || !['CREATE_LINK','CHECK_PAYMENT','RECONCILE','DELIVER'].includes(operation) || !Number.isSafeInteger(amount) || amount<1) {
        throw new Error('Confirmação interativa H4 obrigatória.');
    }
    const terminal=createInterface({input,output,terminal:false});
    const phrase=operation+' H4 CREDITO '+amount+' CENTAVOS';
    try{
        output.write('H4: '+operation+' · Crédito · '+amount+' centavos · banco infinitepay_credit_homologacao · '+publicOrigin+'\n');
        return await terminal.question('Digite exatamente '+phrase+': ')===phrase;
    }finally{terminal.close();}
}
