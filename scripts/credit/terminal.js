import { createInterface } from 'node:readline/promises';
export async function confirmCreditAuthorization({publicOrigin,input=process.stdin,output=process.stdout}) {
    if(!input.isTTY || !output.isTTY)throw new Error('Autorização interativa obrigatória.');
    const terminal=createInterface({input,output,terminal:false});
    const phrase='AUTORIZO UM LINK H4 BRL 100 CREDITO 1X CONTA matheuszxp MINIMO NAO CONFIRMADO';
    try{
        output.write('Autorização privada de um link H4 de R$ 1,00, Crédito pretendido em 1x, válida por 15 minutos.\n'+
            'Banco: infinitepay_credit_homologacao em 127.0.0.1:55439. HTTPS: '+publicOrigin+'\n'+
            'Confirme no App que a credencial protegida pertence à conta matheuszxp; não há validação independente dessa titularidade.\n'+
            'Mínimo contratual não confirmado: pesquisa e experiência não garantem aceitação. assured_installments não limita parcelas.\n'+
            'Este registro não envia POST /links nem autoriza consulta financeira, reconciliação ou entrega.\n');
        return await terminal.question('Digite exatamente '+phrase+': ')===phrase;
    }finally{terminal.close();}
}
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
