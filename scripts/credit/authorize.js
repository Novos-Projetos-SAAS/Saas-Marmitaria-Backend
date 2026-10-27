import { inspectCreditEnvironment } from './diagnose.js';
import { privateDirectory } from './environment.js';
import { registerCreationApproval } from './authorization.js';
import { confirmCreditAuthorization } from './terminal.js';

try{
    if(!process.stdin.isTTY || !process.stdout.isTTY || process.env.NODE_ENV!=='development' || process.env.INFINITEPAY_CHECKOUT_ENABLED!=='false' ||
        process.env.CREDIT_DPAPI_STATUS!=='VALID')throw new Error();
    const result=await registerCreationApproval({directory:privateDirectory,amount:Number(process.env.CREDIT_AMOUNT_CENTAVOS),
        fingerprint:process.env.CREDIT_CREDENTIAL_SHA256,inspect:inspectCreditEnvironment,confirm:confirmCreditAuthorization});
    console.log(JSON.stringify(result,null,2));
}catch{console.error('Autorização H4 não registrada. Não substitua arquivos existentes; consulte Diagnose. Nenhum envio financeiro.');process.exitCode=1;}
